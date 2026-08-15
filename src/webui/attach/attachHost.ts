import { randomBytes, randomUUID } from 'crypto'
import { chmodSync, rmSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import {
  ATTACH_PROTOCOL_VERSION,
  AttachRequestSchema,
  MAX_ATTACH_REPLAY_EVENTS,
  type AttachEventBody,
  type AttachEventEnvelope,
  type AttachOutbound,
  type AttachResponse,
  type WebImagePayload,
  type WebPermissionRequest,
  type WebSessionMeta,
  type WebModelOption,
} from '../protocol/attachSchemas.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import {
  diffSnapshots,
  toWireSnapshot,
  type WebTranscriptSnapshot,
} from '../protocol/transcriptWire.js'
import {
  removeAttachDescriptor,
  writeAttachDescriptor,
  type AttachDescriptor,
} from './attachDescriptor.js'
import { attachNdjsonReader, writeNdjson } from './ndjsonConnection.js'
import {
  createWebPermissionBroker,
  type WebPermissionCallbacks,
} from './permissionBroker.js'
import type { AttachRuntime } from './runtime.js'
import {
  ATTACH_FILE_MODE,
  ensureAttachDir,
  getAttachSocketPath,
  isAttachSupportedPlatform,
} from './security.js'

type Connection = {
  socket: Socket
  authenticated: boolean
  subscribed: boolean
}

export type AttachHost = {
  readonly descriptor: AttachDescriptor
  readonly ready: Promise<void>
  /**
   * False while nothing is subscribed. Every publisher must check this first:
   * this host runs in every interactive process, and almost every process is
   * never attached to.
   */
  readonly hasSubscribers: boolean
  readonly permissions: WebPermissionCallbacks
  registerRuntime(runtime: AttachRuntime): void
  /** Diff the transcript and push a patch. No-op with no subscribers. */
  publishTranscript(): void
  /** Push session metadata (state, model, mode, cost). No-op with no subscribers. */
  publishMeta(): void
  publishTodos(): void
  setSessionId(sessionId: string): void
  stop(): void
}

export type StartAttachHostOptions = {
  sessionId: string
  cwd: string
  entrypoint?: string
  /** Process-wide cost, read lazily so the host does not import bootstrap state. */
  getCost?: () => { costUsd: number; linesAdded: number; linesRemoved: number }
}

/**
 * Resolves a transcript item id back to the image bytes it stands for.
 *
 * Reading from the live message list rather than a cache is what stops a stale
 * copy existing at all. The id format is `${message.uuid}:${blockIndex}`, set by
 * `toWireSnapshot`.
 */
function findImage(
  runtime: AttachRuntime,
  itemId: string,
): WebImagePayload | undefined {
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

export function startAttachHost(
  options: StartAttachHostOptions,
): AttachHost | null {
  if (!isAttachSupportedPlatform()) return null

  const pid = process.pid
  const socketPath = getAttachSocketPath(pid)

  ensureAttachDir()
  // A previous process with this PID may have died without cleanup. We own the
  // PID now, so its leftovers are ours to clear.
  rmSync(socketPath, { force: true })

  const descriptor: AttachDescriptor = {
    protocolVersion: ATTACH_PROTOCOL_VERSION,
    pid,
    processNonce: randomUUID(),
    attachToken: randomBytes(32).toString('base64url'),
    socketPath,
    sessionId: options.sessionId,
    cwd: options.cwd,
    entrypoint: options.entrypoint,
    startedAt: Date.now(),
  }

  const connections = new Set<Connection>()
  const replay: AttachEventEnvelope[] = []
  let sessionEpoch = 0
  let seq = 0
  let stopped = false
  let runtime: AttachRuntime | null = null
  let lastTranscript: WebTranscriptSnapshot = { items: [], order: [] }
  let lastMetaJson = ''

  const permissions = createWebPermissionBroker({
    onOpened(request) {
      emit({ kind: 'permission_opened', request })
      publishMeta()
    },
    onClosed(requestId, outcome) {
      emit({ kind: 'permission_closed', requestId, outcome })
      publishMeta()
    },
  })

  function hasSubscribers(): boolean {
    for (const connection of connections) {
      if (connection.subscribed) return true
    }
    return false
  }

  function emit(event: AttachEventBody): void {
    seq += 1
    const envelope: AttachEventEnvelope = { type: 'event', seq, event }
    replay.push(envelope)
    if (replay.length > MAX_ATTACH_REPLAY_EVENTS) replay.shift()
    for (const connection of connections) {
      if (connection.subscribed) writeNdjson(connection.socket, envelope)
    }
  }

  /**
   * Options the browser may switch to. The null-valued "Default" entry is
   * dropped, because `set_model` carries a model id and cannot express it.
   */
  function listModels(): WebModelOption[] {
    try {
      return getModelOptions()
        .filter(option => typeof option.value === 'string')
        .map(option => ({ value: option.value as string, label: option.label }))
    } catch {
      // A misconfigured provider registry must not break attaching.
      return []
    }
  }

  function buildMeta(): WebSessionMeta {
    const cost = options.getCost?.()
    return {
      pid,
      processNonce: descriptor.processNonce,
      sessionId: descriptor.sessionId,
      sessionEpoch,
      cwd: descriptor.cwd,
      entrypoint: descriptor.entrypoint,
      startedAt: descriptor.startedAt,
      model: runtime?.getModel(),
      permissionMode: runtime?.getPermissionMode(),
      state: runtime?.getState() ?? 'idle',
      costUsd: cost?.costUsd,
      linesAdded: cost?.linesAdded,
      linesRemoved: cost?.linesRemoved,
    }
  }

  function publishTranscript(): void {
    if (!hasSubscribers() || !runtime) return
    const next = toWireSnapshot(runtime.getMessages())
    const patch = diffSnapshots(lastTranscript, next)
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

  function sendSnapshot(connection: Connection, afterSeq?: number): void {
    // Replay is only valid if every event the client missed is still buffered.
    if (afterSeq !== undefined && replay.length > 0) {
      const earliest = replay[0]!.seq
      if (afterSeq >= earliest - 1 && afterSeq <= seq) {
        for (const envelope of replay) {
          if (envelope.seq > afterSeq) writeNdjson(connection.socket, envelope)
        }
        return
      }
    }

    // Full snapshot. Capturing the watermark before serializing means any event
    // produced while we write is replayed after, never dropped or duplicated.
    const watermark = seq
    const transcript = runtime
      ? toWireSnapshot(runtime.getMessages())
      : { items: [], order: [] }
    lastTranscript = transcript

    const snapshot: AttachEventEnvelope = {
      type: 'event',
      seq: watermark,
      event: {
        kind: 'snapshot',
        meta: buildMeta(),
        transcript,
        permissions: permissions.pending(),
        todos: runtime?.getTodos() ?? [],
        models: listModels(),
      },
    }
    writeNdjson(connection.socket, snapshot)

    for (const envelope of replay) {
      if (envelope.seq > watermark) writeNdjson(connection.socket, envelope)
    }
  }

  function respond(
    socket: Socket,
    requestId: string,
    ok: boolean,
    payload?: { result?: unknown; error?: { code: string; message: string } },
  ): void {
    writeNdjson(socket, {
      type: 'response',
      requestId,
      ok,
      ...payload,
    } satisfies AttachResponse)
  }

  const server: Server = createServer(socket => {
    const connection: Connection = {
      socket,
      authenticated: false,
      subscribed: false,
    }
    connections.add(connection)

    attachNdjsonReader(socket, {
      onLine(line) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          respond(socket, 'unknown', false, {
            error: { code: 'bad_json', message: 'line was not valid JSON' },
          })
          return
        }

        const request = AttachRequestSchema.safeParse(parsed)
        if (!request.success) {
          respond(socket, 'unknown', false, {
            error: {
              code: 'bad_request',
              message: 'request failed schema validation',
            },
          })
          return
        }

        const { requestId, request: body } = request.data

        if (body.kind === 'hello') {
          // A constant-time compare adds nothing: the token is only readable by
          // a process that can already read a 0600 file in a 0700 directory
          // owned by this user.
          if (body.token !== descriptor.attachToken) {
            respond(socket, requestId, false, {
              error: { code: 'unauthorized', message: 'bad attach token' },
            })
            socket.destroy()
            return
          }
          connection.authenticated = true
          respond(socket, requestId, true, { result: buildMeta() })
          return
        }

        if (!connection.authenticated) {
          respond(socket, requestId, false, {
            error: { code: 'unauthorized', message: 'send hello first' },
          })
          socket.destroy()
          return
        }

        switch (body.kind) {
          case 'subscribe': {
            connection.subscribed = true
            sendSnapshot(connection, body.afterSeq)
            respond(socket, requestId, true, { result: { seq } })
            return
          }

          case 'submit': {
            if (!runtime) {
              respond(socket, requestId, false, {
                error: {
                  code: 'runtime_not_ready',
                  message: 'the session is still starting',
                },
              })
              return
            }
            if (body.sessionEpoch !== sessionEpoch) {
              // The prompt was composed against a session this process has
              // since left, via /resume or /clear.
              respond(socket, requestId, false, {
                error: {
                  code: 'stale_epoch',
                  message: 'the session changed; resynchronize and retry',
                },
              })
              return
            }
            if (!body.content && !body.images?.length) {
              // The schema cannot express "one of these two", because a refined
              // member cannot sit in a discriminated union.
              respond(socket, requestId, false, {
                error: {
                  code: 'empty_submit',
                  message: 'a submit needs text or at least one image',
                },
              })
              return
            }
            runtime.submit(
              body.content,
              body.delivery,
              body.commandId,
              body.images,
            )
            respond(socket, requestId, true)
            return
          }

          case 'get_image': {
            const image = runtime ? findImage(runtime, body.itemId) : undefined
            if (!image) {
              respond(socket, requestId, false, {
                error: {
                  code: 'no_such_image',
                  message: 'that transcript item is not an image',
                },
              })
              return
            }
            respond(socket, requestId, true, { result: image })
            return
          }

          case 'interrupt': {
            runtime?.interrupt()
            respond(socket, requestId, true)
            return
          }

          case 'permission_decision': {
            const handled = permissions.resolve(body.requestId, body.decision)
            respond(socket, requestId, handled, {
              ...(handled
                ? {}
                : {
                    error: {
                      code: 'interaction_not_pending',
                      message: 'that request was already resolved',
                    },
                  }),
            })
            return
          }

          case 'set_permission_mode': {
            runtime?.setPermissionMode(body.mode)
            respond(socket, requestId, true)
            return
          }

          case 'set_model': {
            runtime?.setModel(body.model)
            respond(socket, requestId, true)
            return
          }
        }
      },
      onError() {
        connections.delete(connection)
      },
      onClose() {
        connections.delete(connection)
      },
    })
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
    // A failed attach listener must never take the session down with it.
    markFailed(err)
    stop()
  })

  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, ATTACH_FILE_MODE)
      writeAttachDescriptor(descriptor)
      markReady()
    } catch (err) {
      markFailed(err as Error)
      stop()
    }
  })

  // The attach listener alone must not keep a finished headless process alive.
  server.unref()

  function stop(): void {
    if (stopped) return
    stopped = true
    for (const connection of connections) {
      connection.socket.destroy()
    }
    connections.clear()
    server.close()
    rmSync(socketPath, { force: true })
    removeAttachDescriptor(pid)
  }

  return {
    descriptor,
    ready,
    permissions,
    get hasSubscribers() {
      return hasSubscribers()
    },
    registerRuntime(next: AttachRuntime) {
      runtime = next
      publishMeta()
    },
    publishTranscript,
    publishMeta,
    publishTodos,
    setSessionId(sessionId: string) {
      if (sessionId === descriptor.sessionId) return
      // The socket path stays put. Only the identity on it moves, and the epoch
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
