/**
 * The session wire surface — one process's HTTP commands + SSE event stream.
 *
 * Successor of the v1 unix-socket attach host: same seq-numbered journal with
 * bounded replay (a reconnecting client resumes from `Last-Event-ID`, or gets
 * `resync_required` and a fresh snapshot once the ring has expired), same
 * publish-on-mutation discipline, now over the single v2 trunk so the TUI,
 * the browser and (via the gateway) any tunnelled client consume exactly the
 * events defined in `session/wire.ts`.
 *
 * Loopback TCP, one bearer token (the descriptor file, 0600). The gateway
 * terminates browser auth and forwards with this token; direct local
 * consumers read the descriptor.
 *
 * The request broker is mirrored, not re-implemented: any ask-site that opens
 * a request on the session broker shows up as `request_opened` here, and
 * `POST /request_respond` answers it through the same claim() race the
 * terminal dialog uses. (The broker resolved here is the ROOT scope's, which
 * is every single-session process; per-scope surfaces arrive with sessiond.)
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  WIRE_VERSION,
  MAX_WIRE_REPLAY_EVENTS,
  WireCommandSchema,
  WireRequestResponseSchema,
  type WireCatalog,
  type WireEvent,
  type WireEventEnvelope,
  type WireImagePayload,
  type WirePendingCommand,
  type WirePermissionMode,
  type WireRequest,
  type WireSessionContext,
  type WireSessionMeta,
  type WireTranscriptSnapshot,
} from '../session/wire.js'
import {
  diffWireSnapshots,
  toWireItems,
  wireSnapshot,
} from '../session/toWire.js'
import { currentSessionRequests } from '../session/requests.js'
import type { Message } from '../types/message.js'
import { buildContextMeter } from './contextMeter.js'
import {
  ensureAttachDir,
  removeAttachDescriptor,
  writeAttachDescriptor,
  type AttachDescriptor,
} from './descriptor.js'
import type { SessionRuntime } from './runtime.js'

export const SURFACE_TOKEN_HEADER = 'x-freecode-surface'

/**
 * Modes a tokened client may not set. A surface reachable through a gateway
 * sits behind one password; a mode that stops asking is exactly what an
 * attacker holding that password would choose. The terminal sets these itself.
 */
const MODES_DENIED_TO_REMOTE: ReadonlySet<WirePermissionMode> = new Set([
  'bypassPermissions',
  'dontAsk',
])

export type WireSurface = {
  readonly descriptor: AttachDescriptor
  readonly ready: Promise<void>
  /** `http://127.0.0.1:<port>` once `ready` resolves. */
  readonly url: string
  /**
   * False while nothing is subscribed. Every publisher must check this first:
   * this surface runs in every interactive process, and almost every process
   * is never attached to.
   */
  readonly hasSubscribers: boolean
  registerRuntime(runtime: SessionRuntime): void
  /** Diff the transcript and push a patch. No-op with no subscribers. */
  publishTranscript(): void
  /** Push session metadata (state, model, mode, cost). No-op with no subscribers. */
  publishMeta(): void
  publishTodos(): void
  publishQueue(): void
  publishTasks(): void
  publishCatalog(): void
  /** /resume and /clear move the identity on a live surface. */
  setSessionId(sessionId: string): void
  stop(): void
}

export type StartSurfaceOptions = {
  sessionId: string
  cwd: string
  entrypoint?: string
  /** Process-wide cost, read lazily so the surface does not import bootstrap state. */
  getCost?: () => {
    costUsd: number
    linesAdded: number
    linesRemoved: number
  }
}

type Subscriber = {
  send(envelope: WireEventEnvelope): void
  close(): void
}

function sseFrame(envelope: WireEventEnvelope): string {
  return `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`
}

/**
 * Resolves a transcript item id back to the image bytes it stands for.
 *
 * Reading from the live message list rather than a cache is what stops a stale
 * copy existing at all. The id format is `${message.uuid}:${blockIndex}`, set
 * by `toWireItems`.
 */
function findImage(
  runtime: SessionRuntime,
  itemId: string,
): WireImagePayload | undefined {
  const split = itemId.lastIndexOf(':')
  if (split <= 0) return undefined
  const uuid = itemId.slice(0, split)
  const index = Number(itemId.slice(split + 1))
  if (!Number.isInteger(index) || index < 0) return undefined

  const message = runtime
    .getMessages()
    .find(candidate => candidate.uuid === uuid)
  if (message?.type !== 'user') return undefined

  const content = message.message.content
  if (typeof content === 'string') return undefined
  const block = content[index]
  if (block?.type !== 'image' || block.source.type !== 'base64') {
    return undefined
  }
  return { mediaType: block.source.media_type, data: block.source.data }
}

function permissionModes(): WirePermissionMode[] {
  return ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']
}

export function startWireSurface(
  options: StartSurfaceOptions,
): WireSurface | null {
  ensureAttachDir()

  const pid = process.pid
  const descriptor: AttachDescriptor = {
    wireVersion: WIRE_VERSION,
    pid,
    processNonce: randomUUID(),
    token: randomBytes(32).toString('base64url'),
    // Filled by the listener callback once the OS assigns the port.
    port: 0,
    sessionId: options.sessionId,
    cwd: options.cwd,
    entrypoint: options.entrypoint,
    startedAt: Date.now(),
  }

  const subscribers = new Set<Subscriber>()
  const journal: WireEventEnvelope[] = []
  let sessionEpoch = 0
  let seq = 0
  let stopped = false
  let runtime: SessionRuntime | null = null
  let lastTranscript: WireTranscriptSnapshot = { items: [], order: [] }
  let lastMetaJson = ''
  let lastQueueJson = ''
  let surfaceUrl = ''

  const broker = currentSessionRequests()
  const unsubscribeBroker = broker.subscribe(event => {
    if (event.type === 'opened') {
      emit({ kind: 'request_opened', request: event.request })
      publishMeta()
    } else {
      emit({
        kind: 'request_closed',
        requestId: event.requestId,
        outcome: event.outcome,
      })
      publishMeta()
    }
  })

  function hasSubscribers(): boolean {
    return subscribers.size > 0
  }

  function emit(event: WireEvent): void {
    seq += 1
    const envelope: WireEventEnvelope = { v: WIRE_VERSION, seq, event }
    journal.push(envelope)
    if (journal.length > MAX_WIRE_REPLAY_EVENTS) journal.shift()
    for (const subscriber of subscribers) subscriber.send(envelope)
  }

  function buildMeta(): WireSessionMeta {
    const cost = options.getCost?.()
    const model = runtime?.getModel() ?? null
    const isCompacting = runtime?.getIsCompacting() ?? false
    const inProgressIds = runtime?.getInProgressToolUseIds()
    const meta: WireSessionMeta = {
      sessionId: descriptor.sessionId,
      sessionEpoch,
      cwd: descriptor.cwd,
      startedAt: descriptor.startedAt,
      model,
      permissionMode: runtime?.getPermissionMode(),
      state: runtime?.getState() ?? 'idle',
      activity: isCompacting ? 'compacting' : runtime?.getActivity(),
      costUsd: cost?.costUsd,
      linesAdded: cost?.linesAdded,
      linesRemoved: cost?.linesRemoved,
    }
    if (runtime) {
      const context = buildContext(runtime.getMessages(), model ?? undefined)
      if (context) meta.context = context
    }
    if (inProgressIds && inProgressIds.size > 0) {
      meta.inProgressToolUseIds = Array.from(inProgressIds)
    }
    return meta
  }

  /** The provider registry can be misconfigured; the meta stream must survive. */
  function buildContext(
    messages: readonly Message[],
    model: string | undefined,
  ): WireSessionContext | undefined {
    try {
      return buildContextMeter(messages, model)
    } catch {
      return undefined
    }
  }

  function publishTranscript(): void {
    if (!hasSubscribers() || !runtime) return
    const next = wireSnapshot(toWireItems(runtime.getMessages()))
    const patch = diffWireSnapshots(lastTranscript, next)
    lastTranscript = next
    if (patch) emit({ kind: 'transcript', patch })
  }

  function publishMeta(): void {
    if (!hasSubscribers()) return
    const meta = buildMeta()
    const json = JSON.stringify(meta)
    if (json === lastMetaJson) return
    lastMetaJson = json
    emit({ kind: 'meta', meta })
  }

  function publishTodos(): void {
    if (!hasSubscribers() || !runtime) return
    emit({ kind: 'todos', todos: runtime.getTodos() })
  }

  function publishQueue(): void {
    if (!hasSubscribers() || !runtime) return
    const commands = runtime.getPendingCommands()
    const json = JSON.stringify(commands)
    if (json === lastQueueJson) return
    lastQueueJson = json
    emit({ kind: 'queue', commands })
  }

  function publishTasks(): void {
    if (!hasSubscribers() || !runtime) return
    emit({ kind: 'tasks', tasks: runtime.getTasks() })
  }

  function publishCatalog(): void {
    if (!hasSubscribers() || !runtime) return
    emit({ kind: 'catalog', catalog: runtime.getCatalog() })
  }

  function sendSnapshot(subscriber: Subscriber, afterSeq?: number): void {
    // Replay is only valid if every event the client missed is still buffered.
    if (afterSeq !== undefined && journal.length > 0) {
      const earliest = journal[0]!.seq
      if (afterSeq >= earliest - 1 && afterSeq <= seq) {
        for (const envelope of journal) {
          if (envelope.seq > afterSeq) subscriber.send(envelope)
        }
        return
      }
    }

    // Full snapshot. A client whose position fell out of the ring learns that
    // first, so it can clear derived state before the snapshot rebuilds it.
    if (afterSeq !== undefined) emit({ kind: 'resync_required' })

    // Capturing the watermark before serializing means any event produced while
    // we build is replayed after, never dropped or duplicated. The snapshot
    // rides the watermark itself rather than a new seq: it summarizes what is
    // already in the journal, so asking for it must not advance anything.
    const watermark = seq
    const transcript = runtime
      ? wireSnapshot(toWireItems(runtime.getMessages()))
      : { items: [], order: [] }
    lastTranscript = transcript
    const snapshot: WireEvent = {
      kind: 'snapshot',
      meta: buildMeta(),
      transcript,
      requests: broker.pending() as WireRequest[],
      todos: runtime?.getTodos() ?? [],
      pendingCommands: runtime?.getPendingCommands() ?? [],
      tasks: runtime?.getTasks() ?? [],
      catalog:
        runtime?.getCatalog() ??
        ({
          models: [],
          commands: [],
          permissionModes: permissionModes(),
        } satisfies WireCatalog),
    }
    lastMetaJson = JSON.stringify(snapshot.meta)
    subscriber.send({ v: WIRE_VERSION, seq: watermark, event: snapshot })

    for (const envelope of journal) {
      if (envelope.seq > watermark) subscriber.send(envelope)
    }
  }

  // -----------------------------------------------------------------------
  // HTTP plumbing

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  const ok = (res: ServerResponse, result?: unknown): void => {
    json(res, 200, result === undefined ? { ok: true } : { ok: true, result })
  }

  const fail = (
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
  ): void => {
    json(res, status, { ok: false, error: { code, message } })
  }

  function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      request.on('data', chunk => {
        body += chunk
        // Same ceiling the command schema puts on a prompt body.
        if (body.length > 20 * 1024 * 1024) {
          reject(new Error('body too large'))
          request.destroy()
        }
      })
      request.on('end', () => resolve(body))
      request.on('error', reject)
    })
  }

  function authorized(request: IncomingMessage): boolean {
    return request.headers[SURFACE_TOKEN_HEADER] === descriptor.token
  }

  /**
   * Every route lives under `/v1/sessions/:sessionId/`. The ID must name the
   * session this surface currently serves: after /resume or /clear a client
   * still holding the old ID gets `unknown_session` rather than the new
   * session's events under a stale label.
   */
  function sessionRoute(
    request: IncomingMessage,
    url: URL,
  ): { kind: string; params: string[] } | null {
    const parts = url.pathname.split('/').filter(Boolean)
    // ['v1', 'sessions', sessionId, ...rest]
    if (parts.length < 4 || parts[0] !== 'v1' || parts[1] !== 'sessions') {
      return null
    }
    if (parts[2] !== descriptor.sessionId) return null
    const rest = parts.slice(3)
    if (rest[0] === 'agents' && rest[1] && rest[2] === 'transcript') {
      return { kind: 'agent_transcript', params: [rest[1]] }
    }
    return { kind: rest[0]!, params: rest.slice(1) }
  }

  async function handleCommand(
    request: IncomingMessage,
    res: ServerResponse,
    kind: string,
  ): Promise<void> {
    if (!runtime) {
      fail(res, 503, 'runtime_not_ready', 'the session is still starting')
      return
    }

    let body: unknown
    try {
      const raw = await readBody(request)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      fail(res, 400, 'bad_json', 'body was not valid JSON')
      return
    }

    const command = WireCommandSchema.safeParse(body)
    if (!command.success) {
      fail(res, 400, 'bad_command', 'command failed schema validation')
      return
    }
    if (command.data.kind !== kind) {
      fail(res, 400, 'wrong_route', `this route takes kind '${kind}'`)
      return
    }
    const cmd = command.data

    switch (cmd.kind) {
      case 'prompt': {
        if (cmd.sessionEpoch !== sessionEpoch) {
          fail(
            res,
            409,
            'stale_epoch',
            'the session changed; resynchronize and retry',
          )
          return
        }
        if (!cmd.content && !cmd.images?.length) {
          fail(
            res,
            400,
            'empty_submit',
            'a prompt needs text or at least one image',
          )
          return
        }
        runtime.submit(cmd.content, cmd.delivery, cmd.commandId, cmd.images)
        ok(res)
        return
      }
      case 'cancel': {
        runtime.cancel()
        ok(res)
        return
      }
      case 'request_respond': {
        // The route schema already validated the envelope; re-check the
        // response half so a mismatched kind fails here with a stable code.
        const response = WireRequestResponseSchema.safeParse(cmd.response)
        if (!response.success) {
          fail(res, 400, 'bad_command', 'response failed schema validation')
          return
        }
        // Mode first, then the answer: approvals that change the mode
        // (plan exit) must have the mode applied before tool execution
        // resumes — the same order the pre-v2 browser contract used.
        const decision =
          response.data.kind === 'permission'
            ? response.data.decision
            : undefined
        if (decision?.behavior === 'allow' && decision.setMode) {
          if (MODES_DENIED_TO_REMOTE.has(decision.setMode)) {
            fail(
              res,
              403,
              'mode_not_allowed',
              'this surface cannot set that mode',
            )
            return
          }
          runtime.setMode(decision.setMode)
        }
        const handled = broker.respondTo(cmd.requestId, response.data)
        if (!handled) {
          fail(
            res,
            409,
            'interaction_not_pending',
            'that request was already resolved',
          )
          return
        }
        ok(res)
        return
      }
      case 'model_set': {
        runtime.setModel(cmd.model)
        ok(res)
        return
      }
      case 'mode_set': {
        if (MODES_DENIED_TO_REMOTE.has(cmd.mode)) {
          fail(
            res,
            403,
            'mode_not_allowed',
            'this surface cannot set that mode',
          )
          return
        }
        runtime.setMode(cmd.mode)
        ok(res)
        return
      }
      case 'rpc': {
        if (!runtime.rpc) {
          fail(
            res,
            501,
            'rpc_not_supported',
            'this session does not serve that rpc',
          )
          return
        }
        try {
          const result = await runtime.rpc(cmd.method, cmd.params)
          ok(res, result)
        } catch (err) {
          fail(
            res,
            500,
            'rpc_failed',
            err instanceof Error ? err.message : String(err),
          )
        }
        return
      }
    }
  }

  function handleEvents(
    request: IncomingMessage,
    res: ServerResponse,
    lastEventId: number | undefined,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Comment frame: some proxies hold the response open until the first byte.
    res.write(': open\n\n')

    const subscriber: Subscriber = {
      send(envelope) {
        res.write(sseFrame(envelope))
      },
      close() {
        res.end()
      },
    }
    subscribers.add(subscriber)
    // No meta publish first: the snapshot below carries it.
    sendSnapshot(subscriber, lastEventId)

    request.on('close', () => {
      subscribers.delete(subscriber)
    })
  }

  const server: Server = createServer((request, res) => {
    if (request.method !== 'GET' && request.method !== 'POST') {
      fail(res, 405, 'method_not_allowed', 'use GET or POST')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = sessionRoute(request, url)
    if (!route) {
      fail(res, 404, 'unknown_route', 'not a session route')
      return
    }
    if (!authorized(request)) {
      fail(res, 401, 'unauthorized', 'missing or bad surface token')
      return
    }

    try {
      if (request.method === 'GET') {
        switch (route.kind) {
          case 'events': {
            const header = request.headers['last-event-id']
            const lastEventId =
              typeof header === 'string' && header.trim() !== ''
                ? Number(header)
                : undefined
            handleEvents(
              request,
              res,
              lastEventId !== undefined && Number.isFinite(lastEventId)
                ? lastEventId
                : undefined,
            )
            return
          }
          case 'image': {
            const itemId = url.searchParams.get('itemId') ?? ''
            const image = runtime ? findImage(runtime, itemId) : undefined
            if (!image) {
              fail(
                res,
                404,
                'no_such_image',
                'that transcript item is not an image',
              )
              return
            }
            json(res, 200, image)
            return
          }
          case 'meta': {
            // The handshake read: identity + state without opening a stream.
            json(res, 200, buildMeta())
            return
          }
          case 'agent_transcript': {
            const snapshot = runtime?.getAgentTranscript?.(route.params[0]!)
            if (!snapshot) {
              fail(res, 404, 'no_such_agent', 'no transcript for that agent')
              return
            }
            json(res, 200, snapshot)
            return
          }
          default:
            fail(res, 404, 'unknown_route', 'not a GET route')
            return
        }
      }

      switch (route.kind) {
        case 'prompt':
        case 'cancel':
        case 'request_respond':
        case 'model':
        case 'mode':
        case 'rpc': {
          const kindMap: Record<string, string> = {
            model: 'model_set',
            mode: 'mode_set',
          }
          void handleCommand(request, res, kindMap[route.kind] ?? route.kind)
          return
        }
        default:
          fail(res, 404, 'unknown_route', 'not a POST route')
          return
      }
    } catch {
      // A route that threw after writing its head cannot also fail cleanly.
      if (!res.headersSent) fail(res, 500, 'surface_error', 'handler failed')
    }
  })

  let markReady: () => void
  let markFailed: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve
    markFailed = reject
  })
  // Nothing awaits `ready` on the startup path, and an unhandled rejection
  // would take the session down over a feature it is not using.
  ready.catch(() => {})

  server.on('error', (err: Error) => {
    markFailed(err)
    stop()
  })

  server.listen({ port: 0, host: '127.0.0.1' }, () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      markFailed(new Error('surface listener has no port'))
      stop()
      return
    }
    descriptor.port = address.port
    surfaceUrl = `http://127.0.0.1:${address.port}`
    try {
      writeAttachDescriptor(descriptor)
      markReady()
    } catch (err) {
      markFailed(err as Error)
      stop()
    }
  })

  // The surface alone must not keep a finished headless process alive.
  server.unref()

  function stop(): void {
    if (stopped) return
    stopped = true
    unsubscribeBroker()
    for (const subscriber of subscribers) subscriber.close()
    subscribers.clear()
    server.close()
    removeAttachDescriptor(pid)
  }

  return {
    descriptor,
    ready,
    get url() {
      return surfaceUrl
    },
    get hasSubscribers() {
      return hasSubscribers()
    },
    registerRuntime(next: SessionRuntime) {
      runtime = next
      publishMeta()
    },
    publishTranscript,
    publishMeta,
    publishTodos,
    publishQueue,
    publishTasks,
    publishCatalog,
    setSessionId(sessionId: string) {
      if (sessionId === descriptor.sessionId) return
      // The surface stays put. Only the identity on it moves, and the epoch
      // bump lets a stale queued prompt be rejected instead of applied to the
      // session the user just switched to.
      descriptor.sessionId = sessionId
      sessionEpoch += 1
      lastTranscript = { items: [], order: [] }
      try {
        writeAttachDescriptor(descriptor)
      } catch {
        // A descriptor rewrite failure loses discovery, not correctness.
      }
      emit({ kind: 'session_changed', sessionId, sessionEpoch })
      publishTranscript()
    },
    stop,
  }
}

/** The pending-command shape the runtime contract exposes. */
export type { WirePendingCommand }
