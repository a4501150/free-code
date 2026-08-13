import { randomBytes, randomUUID } from 'crypto'
import { chmodSync, rmSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import {
  ATTACH_PROTOCOL_VERSION,
  AttachRequestSchema,
  type AttachOutbound,
} from '../protocol/attachSchemas.js'
import {
  removeAttachDescriptor,
  writeAttachDescriptor,
  type AttachDescriptor,
} from './attachDescriptor.js'
import { attachNdjsonReader, writeNdjson } from './ndjsonConnection.js'
import {
  ATTACH_FILE_MODE,
  ensureAttachDir,
  getAttachSocketPath,
  isAttachSupportedPlatform,
} from './security.js'

type Connection = {
  socket: Socket
  authenticated: boolean
}

export type AttachHost = {
  readonly descriptor: AttachDescriptor
  /**
   * Resolves once the socket is listening and the descriptor is on disk, so a
   * client cannot read a descriptor that does not exist yet. Startup does not
   * await this; only a caller that needs the socket immediately does.
   */
  readonly ready: Promise<void>
  /**
   * False while nothing is attached. Callers must check this before doing any
   * work to produce an event, because this host runs in every interactive
   * process and most processes are never attached to.
   */
  readonly hasSubscribers: boolean
  publish(event: { kind: string; [key: string]: unknown }): void
  setSessionId(sessionId: string): void
  stop(): void
}

export type StartAttachHostOptions = {
  sessionId: string
  cwd: string
  entrypoint?: string
}

/**
 * Starts this process's attach socket.
 *
 * Keyed by PID rather than session ID: `/resume` changes a process's session ID
 * mid-flight, and two processes can legitimately hold one session ID after an
 * ownership takeover. The process is the stable control target.
 */
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
  let sessionEpoch = 0
  let seq = 0
  let stopped = false

  const server: Server = createServer(socket => {
    const connection: Connection = { socket, authenticated: false }
    connections.add(connection)

    attachNdjsonReader(socket, {
      onLine(line) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          fail(socket, 'bad_json', 'line was not valid JSON')
          return
        }

        const request = AttachRequestSchema.safeParse(parsed)
        if (!request.success) {
          fail(socket, 'bad_request', 'request failed schema validation')
          return
        }

        const body = request.data.request
        if (body.kind === 'hello') {
          // Timing-safe comparison is not meaningful here: the token is only
          // reachable by a process that can already read a 0600 file in a 0700
          // directory owned by this user.
          if (body.token !== descriptor.attachToken) {
            respond(socket, {
              type: 'response',
              requestId: request.data.requestId,
              ok: false,
              error: { code: 'unauthorized', message: 'bad attach token' },
            })
            socket.destroy()
            return
          }
          connection.authenticated = true
          respond(socket, {
            type: 'response',
            requestId: request.data.requestId,
            ok: true,
            result: {
              pid,
              processNonce: descriptor.processNonce,
              sessionId: descriptor.sessionId,
              sessionEpoch,
            },
          })
          return
        }

        if (!connection.authenticated) {
          fail(socket, 'unauthorized', 'send hello first')
          socket.destroy()
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

  function respond(socket: Socket, message: AttachOutbound): void {
    writeNdjson(socket, message)
  }

  function fail(socket: Socket, code: string, message: string): void {
    writeNdjson(socket, {
      type: 'response',
      requestId: 'unknown',
      ok: false,
      error: { code, message },
    } satisfies AttachOutbound)
  }

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
    get hasSubscribers() {
      for (const connection of connections) {
        if (connection.authenticated) return true
      }
      return false
    },
    publish(event) {
      seq += 1
      const envelope: AttachOutbound = {
        type: 'event',
        processNonce: descriptor.processNonce,
        sessionId: descriptor.sessionId,
        sessionEpoch,
        seq,
        event,
      }
      for (const connection of connections) {
        if (connection.authenticated) writeNdjson(connection.socket, envelope)
      }
    },
    setSessionId(sessionId) {
      if (sessionId === descriptor.sessionId) return
      // The socket path stays put. Only the identity on it moves, and the epoch
      // bump lets the gateway reject commands composed against the old session.
      descriptor.sessionId = sessionId
      sessionEpoch += 1
      try {
        writeAttachDescriptor(descriptor)
      } catch {
        // A descriptor rewrite failure loses discovery, not correctness.
      }
    },
    stop,
  }
}
