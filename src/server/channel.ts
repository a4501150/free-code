/**
 * One session's wire channel: the seq-numbered journal, the publish path, and
 * the request/response handlers, free of any listener or descriptor.
 *
 * Extracted from the single-session surface so one HTTP server can host N of
 * them (sessiond). Everything session-specific lives here — the journal, the
 * sequence, the epoch, the cached snapshots a later publish diffs against —
 * and nothing here knows about ports, descriptor files, or token checks.
 *
 * The request broker is a handle, not a lookup: a single-session process
 * passes (or defaults to) the root scope's broker; a hosted session passes
 * the handle resolved inside its own session scope at creation, so events
 * from session A never reach session B's subscribers even though both
 * channels run in one process.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
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
  type WireNotification,
  type WireSessionContext,
  type WireSessionMeta,
  type WireStreamDraft,
  type WireTranscriptSnapshot,
} from '../session/wire.js'
import type { SessionEvent } from '../session/events.js'
import {
  diffWireSnapshots,
  toWireItems,
  wireSnapshot,
} from '../session/toWire.js'
import {
  currentSessionRequests,
  type SessionRequestBroker,
} from '../session/requests.js'
import type { Message } from '../types/message.js'
import { buildContextMeter } from './contextMeter.js'
import type { SessionRuntime } from './runtime.js'

/**
 * Modes a tokened client may not set. A surface reachable through a gateway
 * sits behind one password; a mode that stops asking is exactly what an
 * attacker holding that password would choose. The terminal sets these itself.
 */
const MODES_DENIED_TO_REMOTE: ReadonlySet<WirePermissionMode> = new Set([
  'bypassPermissions',
  'dontAsk',
])

export type SessionChannel = {
  /** The session this channel serves right now; moves on /resume and /clear. */
  readonly sessionId: string
  readonly sessionEpoch: number
  /**
   * False while nothing is subscribed. Every publisher must check this first:
   * a channel runs in every interactive process, and almost every process
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
  /** Push a host-surfaced message (toast). No-op with no subscribers. */
  publishNotify(notification: WireNotification): void
  /** /resume and /clear move the identity on a live channel. */
  setSessionId(sessionId: string): void
  /** GET route halves: `events`, `image`, `meta`, `agent_transcript`. */
  handleGet(
    request: IncomingMessage,
    res: ServerResponse,
    kind: string,
    params: string[],
    url: URL,
  ): void
  /** POST command halves; `kind` is the wire kind the route enforces. */
  handlePost(
    request: IncomingMessage,
    res: ServerResponse,
    kind: string,
  ): Promise<void>
  stop(): void
}

export type SessionChannelOptions = {
  sessionId: string
  cwd: string
  startedAt?: number
  /** Process-wide cost, read lazily so the channel does not import bootstrap state. */
  getCost?: () => {
    costUsd: number
    linesAdded: number
    linesRemoved: number
  }
  /**
   * Minimum interval between `stream` draft frames while a turn streams.
   * A test can widen or zero it; production leaves the default.
   */
  streamThrottleMs?: number
  /**
   * The session's request broker. Omitted by single-session processes,
   * which resolve the root scope's broker here themselves.
   */
  broker?: SessionRequestBroker
  /** Notified when setSessionId moves the identity, to rewrite a descriptor. */
  onSessionIdChanged?: (sessionId: string) => void
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

export function createSessionChannel(
  options: SessionChannelOptions,
): SessionChannel {
  let sessionId = options.sessionId
  let sessionEpoch = 0

  const subscribers = new Set<Subscriber>()
  const journal: WireEventEnvelope[] = []
  let seq = 0
  let stopped = false
  let runtime: SessionRuntime | null = null
  let lastTranscript: WireTranscriptSnapshot = { items: [], order: [] }
  let lastMetaJson = ''
  let lastQueueJson = ''

  // Streaming preview. The draft is a cumulative snapshot folded from the
  // core's streaming events; frames are throttled (>= streamThrottleMs apart,
  // last-one-wins with a trailing emit) and the pending frame is always
  // flushed before a transcript patch, so the preview never goes backwards
  // past the moment the committed rows landed.
  const streamThrottleMs = options.streamThrottleMs ?? 50
  let streamDraft: WireStreamDraft | null = null
  let streamDirty = false
  let streamTimer: ReturnType<typeof setTimeout> | null = null
  let lastStreamEmit = 0
  let unsubscribeCoreEvents: (() => void) | null = null

  function discardStream(): void {
    if (streamTimer) {
      clearTimeout(streamTimer)
      streamTimer = null
    }
    streamDraft = null
    streamDirty = false
  }

  function flushStream(): void {
    if (streamTimer) {
      clearTimeout(streamTimer)
      streamTimer = null
    }
    if (!streamDirty || !hasSubscribers()) {
      streamDirty = false
      return
    }
    streamDirty = false
    lastStreamEmit = Date.now()
    emit({ kind: 'stream', draft: streamDraft })
  }

  function updateStream(next: WireStreamDraft | null): void {
    streamDraft = next
    streamDirty = true
    if (!hasSubscribers()) return
    const wait = streamThrottleMs - (Date.now() - lastStreamEmit)
    if (wait <= 0) {
      flushStream()
      return
    }
    // Last-one-wins: one trailing timer for the window, never one per event.
    if (!streamTimer) {
      streamTimer = setTimeout(() => {
        streamTimer = null
        flushStream()
      }, wait)
      streamTimer.unref?.()
    }
  }

  function foldStreamEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'streaming_text':
        updateStream({
          ...(streamDraft ?? { tools: [] }),
          text: event.text ?? undefined,
        })
        return
      case 'streaming_thinking':
        updateStream({
          ...(streamDraft ?? { tools: [] }),
          thinking: event.thinking?.thinking,
        })
        return
      case 'streaming_tool_uses':
        updateStream({
          ...(streamDraft ?? {}),
          tools: event.toolUses.map(toolUse => ({
            toolName: toolUse.contentBlock?.name,
            partialJson: toolUse.unparsedToolInput,
          })),
        })
        return
      case 'turn_started':
        discardStream()
        return
      case 'turn_finished': {
        // The turn's last word: flush the final draft (before whatever
        // transcript patch follows), then close the preview with an explicit
        // null so a client that never saw a patch cannot strand the draft.
        flushStream()
        const hadDraft = streamDraft !== null
        discardStream()
        if (hadDraft && hasSubscribers()) {
          emit({ kind: 'stream', draft: null })
        }
        return
      }
      default:
        return
    }
  }

  function publishNotify(notification: WireNotification): void {
    if (!hasSubscribers()) return
    emit({ kind: 'notify', notification })
  }

  const broker = options.broker ?? currentSessionRequests()
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
      sessionId,
      sessionEpoch,
      cwd: options.cwd,
      startedAt: options.startedAt ?? Date.now(),
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
    // The committed rows end the preview they stood in for: flush the last
    // draft frame first so the stream order is stream-then-transcript.
    flushStream()
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

  function handleGet(
    request: IncomingMessage,
    res: ServerResponse,
    kind: string,
    params: string[],
    url: URL,
  ): void {
    switch (kind) {
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
        // The loader is usually async (it reads the sidechain JSONL), so this
        // half answers after the handler returned. The response head has not
        // been written yet, and every path below answers exactly once; a
        // throwing loader must still answer, or the request hangs.
        void Promise.resolve(runtime?.getAgentTranscript?.(params[0]!)).then(
          snapshot => {
            if (!snapshot) {
              fail(res, 404, 'no_such_agent', 'no transcript for that agent')
              return
            }
            json(res, 200, snapshot)
          },
          () =>
            fail(res, 500, 'rpc_failed', 'the agent transcript failed to load'),
        )
        return
      }
      default:
        fail(res, 404, 'unknown_route', 'not a GET route')
        return
    }
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    unsubscribeBroker()
    unsubscribeCoreEvents?.()
    discardStream()
    for (const subscriber of subscribers) subscriber.close()
    subscribers.clear()
  }

  return {
    get sessionId() {
      return sessionId
    },
    get sessionEpoch() {
      return sessionEpoch
    },
    get hasSubscribers() {
      return hasSubscribers()
    },
    registerRuntime(next: SessionRuntime) {
      runtime = next
      // Streaming drafts are folded live, not journaled: a late subscriber
      // gets the snapshot (no preview) and the next frame.
      unsubscribeCoreEvents?.()
      unsubscribeCoreEvents = next.subscribeCore?.(foldStreamEvent) ?? null
      publishMeta()
    },
    publishTranscript,
    publishMeta,
    publishTodos,
    publishQueue,
    publishTasks,
    publishCatalog,
    publishNotify,
    setSessionId(next: string) {
      if (next === sessionId) return
      // The channel stays put. Only the identity on it moves, and the epoch
      // bump lets a stale queued prompt be rejected instead of applied to the
      // session the user just switched to.
      sessionId = next
      sessionEpoch += 1
      lastTranscript = { items: [], order: [] }
      discardStream()
      options.onSessionIdChanged?.(next)
      emit({ kind: 'session_changed', sessionId: next, sessionEpoch })
      publishTranscript()
    },
    handleGet,
    handlePost: handleCommand,
    stop,
  }
}
