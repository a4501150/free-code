import { randomBytes, randomUUID } from 'crypto'
import { chmodSync, rmSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import {
  ATTACH_PROTOCOL_VERSION,
  AttachRequestSchema,
  DEFAULT_TASK_OUTPUT_TAIL_BYTES,
  MAX_ATTACH_REPLAY_EVENTS,
  MAX_TASK_OUTPUT_TAIL_BYTES,
  type AttachEventBody,
  type AttachEventEnvelope,
  type AttachOutbound,
  type AttachResponse,
  type WebImagePayload,
  type WebPermissionRequest,
  type WebSessionMeta,
  type WebModelOption,
  type WebTaskOutput,
  type WebSessionContext,
} from '../webui/protocol/attachSchemas.js'
import type { DomainUserContentBlock } from '../types/domain.js'
import { isTerminalTaskStatus } from '../Task.js'
import { StopTaskError } from '../tasks/stopTask.js'
import {
  getTaskOutputDelta,
  getTaskOutputTail,
} from '../utils/task/diskOutput.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { buildContextMeter } from './contextMeter.ts'
import {
  diffSnapshots,
  toWireSnapshot,
  type WebTranscriptSnapshot,
} from '../webui/protocol/transcriptWire.js'
import {
  removeAttachDescriptor,
  writeAttachDescriptor,
  type AttachDescriptor,
} from './descriptor.js'
import {
  readNdjsonSocket,
  writeNdjson,
} from '../webui/gateway/ndjsonConnection.js'
import {
  createWebPermissionBroker,
  type WebPermissionCallbacks,
} from './permissionBroker.ts'
import type { AttachRuntime } from './runtime.ts'
import {
  ATTACH_FILE_MODE,
  ensureAttachDir,
  getAttachSocketPath,
  isAttachSupportedPlatform,
} from './security.ts'

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
  publishPendingCommands(): void
  /** Diff the background-task list and push it. No-op with no subscribers. */
  publishTasks(): void
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
 * `toWireSnapshot`, with a third `${partIndex}` segment for an image nested
 * inside a tool_result's content array.
 */
function findImage(
  runtime: AttachRuntime,
  itemId: string,
): WebImagePayload | undefined {
  const [uuid, indexText, partText, ...rest] = itemId.split(':')
  if (!uuid || !indexText || rest.length > 0) return undefined
  const index = Number(indexText)
  if (!Number.isInteger(index) || index < 0) return undefined
  const partIndex = partText === undefined ? undefined : Number(partText)
  if (
    partIndex !== undefined &&
    (!Number.isInteger(partIndex) || partIndex < 0)
  ) {
    return undefined
  }

  const message = runtime
    .getMessages()
    .find(candidate => candidate.uuid === uuid)
  if (message?.type !== 'user') return undefined

  const content = message.message.content
  if (typeof content === 'string') return undefined
  let block = content[index] as DomainUserContentBlock | undefined
  if (partIndex !== undefined) {
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)) {
      return undefined
    }
    block = block.content[partIndex] as DomainUserContentBlock | undefined
  }
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

  /**
   * Reads the provider registry for the window size, so it carries the same
   * guard as `listModels` for the same reason. This one runs on every publish,
   * so a throw here would break the metadata stream rather than one control.
   */
  function buildContext(
    model: string | undefined,
  ): WebSessionContext | undefined {
    if (!runtime) return undefined
    try {
      return buildContextMeter(runtime.getMessages(), model)
    } catch {
      return undefined
    }
  }

  function buildMeta(): WebSessionMeta {
    const cost = options.getCost?.()
    const model = runtime?.getModel()
    const isCompacting = runtime?.getIsCompacting() ?? false
    const inProgressIds = runtime?.getInProgressToolUseIds()
    return {
      pid,
      processNonce: descriptor.processNonce,
      sessionId: descriptor.sessionId,
      sessionEpoch,
      cwd: descriptor.cwd,
      entrypoint: descriptor.entrypoint,
      startedAt: descriptor.startedAt,
      model,
      permissionMode: runtime?.getPermissionMode(),
      state: runtime?.getState() ?? 'idle',
      activity: isCompacting ? 'compacting' : runtime?.getActivity(),
      context: buildContext(model),
      costUsd: cost?.costUsd,
      linesAdded: cost?.linesAdded,
      linesRemoved: cost?.linesRemoved,
      inProgressToolUseIds:
        inProgressIds && inProgressIds.size > 0
          ? Array.from(inProgressIds)
          : undefined,
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

  let lastPendingJson = ''
  function publishPendingCommands(): void {
    if (!hasSubscribers() || !runtime) return
    const commands = runtime.getPendingCommands()
    const json = JSON.stringify(commands)
    if (json === lastPendingJson) return
    lastPendingJson = json
    emit({ kind: 'pending_commands', commands })
  }

  let lastTasksJson = ''
  function publishTasks(): void {
    if (!hasSubscribers() || !runtime) return
    const tasks = runtime.getTasks()
    const json = JSON.stringify(tasks)
    if (json === lastTasksJson) return
    lastTasksJson = json
    emit({ kind: 'tasks', tasks })
  }

  /**
   * Per-task transcript streaming for `subscribe_task`.
   *
   * The agent loop has no publish seam to hook (it streams into the task's own
   * message array, and an evicted agent's chain lives only in the sidechain
   * JSONL), so a subscribed task is polled instead — every tick re-renders the
   * wire snapshot and diffs, exactly like the headless transcript poll. The
   * poll stops once the task is terminal (or gone): there is nothing left to
   * stream, and an evicted agent means a disk read per tick.
   */
  const TASK_TRANSCRIPT_POLL_MS = 700
  /** The TUI detail dialog tails on the same cadence. */
  const TASK_OUTPUT_POLL_MS = 1000
  /**
   * One poll's worth of new bytes. Half the wire line limit before
   * JSON-escaping, so a pathological tick of pure newlines still fits one
   * frame under `MAX_ATTACH_LINE_BYTES`.
   */
  const TASK_OUTPUT_POLL_MAX_BYTES = 2 * 1024 * 1024
  type TaskSubscription = {
    subscribers: Set<Connection>
    last: WebTranscriptSnapshot
    timer?: ReturnType<typeof setInterval>
    inFlight?: boolean
    /** Agent chains stream as transcript patches; shells as output appends. */
    mode: 'transcript' | 'output'
    /** Output mode: file offset the next poll reads from. */
    outputOffset: number
  }
  const taskSubs = new Map<string, TaskSubscription>()

  function stopTaskPoll(taskId: string): void {
    const sub = taskSubs.get(taskId)
    if (!sub) return
    if (sub.timer) clearInterval(sub.timer)
    sub.timer = undefined
  }

  function dropTaskSubscription(taskId: string): void {
    stopTaskPoll(taskId)
    taskSubs.delete(taskId)
  }

  async function pollTaskTranscript(taskId: string): Promise<void> {
    const sub = taskSubs.get(taskId)
    if (!sub || !runtime || sub.subscribers.size === 0) return
    if (sub.inFlight) return
    sub.inFlight = true
    try {
      const got = await runtime.getTaskTranscript(taskId)
      if (!got) {
        // The task is gone from AppState and never had a disk chain.
        dropTaskSubscription(taskId)
        return
      }
      const next = toWireSnapshot(got.messages)
      const patch = diffSnapshots(sub.last, next)
      sub.last = next
      if (patch) emit({ kind: 'task_transcript', taskId, patch })
      const summary = runtime.getTasks().find(task => task.id === taskId)
      if (!summary || isTerminalTaskStatus(summary.status)) {
        // One final diff above carried the tail; nothing more will arrive.
        stopTaskPoll(taskId)
      }
    } catch {
      // A failed read is retryable on the next tick; a browser at worst sees
      // the transcript a poll late.
    } finally {
      sub.inFlight = false
    }
  }

  /**
   * Output streaming for a subscribed shell/monitor: read the file delta
   * since the last tick and emit it, the same tail-and-poll shape the TUI's
   * ShellDetailDialog uses. Stops on the tick that finds the task terminal
   * or gone, after carrying whatever final bytes the file holds.
   */
  async function pollTaskOutput(taskId: string): Promise<void> {
    const sub = taskSubs.get(taskId)
    if (!sub || !runtime || sub.subscribers.size === 0) return
    if (sub.inFlight) return
    sub.inFlight = true
    try {
      const fromOffset = sub.outputOffset
      const delta = await getTaskOutputDelta(
        taskId,
        fromOffset,
        TASK_OUTPUT_POLL_MAX_BYTES,
      )
      sub.outputOffset = delta.newOffset
      const summary = runtime.getTasks().find(task => task.id === taskId)
      const done = !summary || isTerminalTaskStatus(summary.status)
      if (delta.content || done) {
        emit({
          kind: 'task_output',
          taskId,
          append: delta.content,
          fromOffset,
          toOffset: delta.newOffset,
          done,
        })
      }
      if (done) stopTaskPoll(taskId)
    } catch {
      // Retryable like the transcript poll; the next tick reads from the
      // same offset, so a failed read loses nothing.
    } finally {
      sub.inFlight = false
    }
  }

  async function subscribeTask(
    connection: Connection,
    taskId: string,
    fromOffset?: number,
  ): Promise<void> {
    let sub = taskSubs.get(taskId)
    const fresh = !sub
    const summary = runtime?.getTasks().find(task => task.id === taskId)
    const mode: TaskSubscription['mode'] =
      summary &&
      (summary.taskType === 'local_bash' || summary.taskType === 'monitor_mcp')
        ? 'output'
        : 'transcript'
    if (!sub) {
      sub = {
        subscribers: new Set(),
        last: { items: [], order: [] },
        mode,
        outputOffset: 0,
      }
      taskSubs.set(taskId, sub)
    }
    sub.subscribers.add(connection)
    if (fresh && runtime && mode === 'output') {
      // Shell output streams from the client's seed offset when it sent one;
      // with no seed, start at the end of the file so a reconnect does not
      // re-send a multi-megabyte history as one append.
      const baseline = await getTaskOutputTail(taskId, 1)
      sub.outputOffset = fromOffset ?? baseline.bytesTotal
      const done = !summary || isTerminalTaskStatus(summary.status)
      if (done) {
        // Terminal already: one closing frame, no timer to run.
        emit({
          kind: 'task_output',
          taskId,
          append: '',
          fromOffset: sub.outputOffset,
          toOffset: sub.outputOffset,
          done: true,
        })
        return
      }
    } else if (fresh && runtime) {
      // Baseline the diff on the current chain, not on empty: a client that
      // seeded from `get_task_transcript` before subscribing would otherwise
      // get every id back in the first poll's `orderAppend` and render each
      // row twice. The poll has not started yet, so nothing races this read.
      const got = await runtime.getTaskTranscript(taskId)
      sub.last = got ? toWireSnapshot(got.messages) : { items: [], order: [] }
      // The first frame for a new subscriber is always a full replace: it
      // reconciles anything the seed read and this baseline read disagree on,
      // in either arrival order, and it composes with the client's idempotent
      // replace handling instead of relying on delta bookkeeping.
      emit({
        kind: 'task_transcript',
        taskId,
        patch: { type: 'replace', snapshot: sub.last },
      })
    }
    if (!sub.timer) {
      const subscription = sub
      sub.timer = setInterval(
        () => {
          if (subscription.mode === 'output') void pollTaskOutput(taskId)
          else void pollTaskTranscript(taskId)
        },
        mode === 'output' ? TASK_OUTPUT_POLL_MS : TASK_TRANSCRIPT_POLL_MS,
      )
      sub.timer.unref?.()
    }
  }

  function unsubscribeTask(connection: Connection, taskId: string): void {
    const sub = taskSubs.get(taskId)
    if (!sub) return
    sub.subscribers.delete(connection)
    if (sub.subscribers.size === 0) dropTaskSubscription(taskId)
  }

  function clearTaskSubscriptions(): void {
    for (const taskId of [...taskSubs.keys()]) dropTaskSubscription(taskId)
  }

  /**
   * A connection is gone: drop it from the task subscriptions so its polling
   * dies with it rather than streaming into a closed socket.
   */
  function forgetConnection(connection: Connection): void {
    connections.delete(connection)
    for (const [taskId, sub] of [...taskSubs]) {
      sub.subscribers.delete(connection)
      if (sub.subscribers.size === 0) dropTaskSubscription(taskId)
    }
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

    const tasks = runtime?.getTasks() ?? []
    const snapshot: AttachEventEnvelope = {
      type: 'event',
      seq: watermark,
      event: {
        kind: 'snapshot',
        meta: buildMeta(),
        transcript,
        permissions: permissions.pending(),
        todos: runtime?.getTodos() ?? [],
        pendingCommands: runtime?.getPendingCommands() ?? [],
        models: listModels(),
        commands: runtime?.getCommands() ?? [],
        tasks,
      },
    }
    lastTasksJson = JSON.stringify(tasks)
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

    readNdjsonSocket(socket, {
      // Async because task requests read transcripts, which may mean a disk
      // read. The socket serializes lines, so responses still order correctly:
      // each `respond` runs after its own await, and the NDJSON writer is
      // synchronous per frame.
      async onLine(line) {
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

          case 'list_tasks': {
            respond(socket, requestId, true, {
              result: { tasks: runtime?.getTasks() ?? [] },
            })
            return
          }

          case 'get_task_transcript': {
            if (!runtime) {
              respond(socket, requestId, false, {
                error: {
                  code: 'runtime_not_ready',
                  message: 'the session is still starting',
                },
              })
              return
            }
            const summary = runtime
              .getTasks()
              .find(task => task.id === body.taskId)
            if (!summary) {
              respond(socket, requestId, false, {
                error: {
                  code: 'no_such_task',
                  message: 'no task with that id',
                },
              })
              return
            }
            const got = await runtime.getTaskTranscript(body.taskId)
            respond(socket, requestId, true, {
              result: {
                items: got ? toWireSnapshot(got.messages).items : [],
                done: isTerminalTaskStatus(summary.status),
              },
            })
            return
          }

          case 'get_task_output': {
            if (!runtime) {
              respond(socket, requestId, false, {
                error: {
                  code: 'runtime_not_ready',
                  message: 'the session is still starting',
                },
              })
              return
            }
            const summary = runtime
              .getTasks()
              .find(task => task.id === body.taskId)
            if (!summary) {
              respond(socket, requestId, false, {
                error: {
                  code: 'no_such_task',
                  message: 'no task with that id',
                },
              })
              return
            }
            const tailBytes = Math.min(
              body.tailBytes ?? DEFAULT_TASK_OUTPUT_TAIL_BYTES,
              MAX_TASK_OUTPUT_TAIL_BYTES,
            )
            const tail = await getTaskOutputTail(body.taskId, tailBytes)
            respond(socket, requestId, true, {
              result: {
                content: tail.content,
                offset: tail.offset,
                bytesTotal: tail.bytesTotal,
                done: isTerminalTaskStatus(summary.status),
              } satisfies WebTaskOutput,
            })
            return
          }

          case 'subscribe_task': {
            await subscribeTask(connection, body.taskId, body.fromOffset)
            respond(socket, requestId, true)
            return
          }

          case 'unsubscribe_task': {
            unsubscribeTask(connection, body.taskId)
            respond(socket, requestId, true)
            return
          }

          case 'kill_task': {
            if (!runtime) {
              respond(socket, requestId, false, {
                error: {
                  code: 'runtime_not_ready',
                  message: 'the session is still starting',
                },
              })
              return
            }
            try {
              await runtime.killTask(body.taskId)
              respond(socket, requestId, true)
            } catch (err) {
              respond(socket, requestId, false, {
                error: {
                  code: err instanceof StopTaskError ? err.code : 'kill_failed',
                  message:
                    err instanceof Error ? err.message : 'failed to stop task',
                },
              })
            }
            // The kill flips the status; do not wait for the next tick.
            publishTasks()
            publishMeta()
            return
          }
        }
      },
      onError() {
        forgetConnection(connection)
      },
      onClose() {
        forgetConnection(connection)
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
    clearTaskSubscriptions()
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
    publishPendingCommands,
    publishTasks,
    setSessionId(sessionId: string) {
      if (sessionId === descriptor.sessionId) return
      // The socket path stays put. Only the identity on it moves, and the epoch
      // bump lets a stale queued prompt be rejected instead of applied to the
      // session the user just switched to.
      descriptor.sessionId = sessionId
      sessionEpoch += 1
      lastTranscript = { items: [], order: [] }
      // The tasks belonged to the session we just left. Clients re-seed from
      // the new snapshot and re-subscribe whatever they are still viewing.
      clearTaskSubscriptions()
      lastTasksJson = ''
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
