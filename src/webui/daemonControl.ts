import { chmodSync, mkdirSync, rmSync, statSync } from 'fs'
import { createConnection, createServer, type Server } from 'net'
import { join } from 'path'
import { z } from 'zod'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { attachNdjsonReader, writeNdjson } from './attach/ndjsonConnection.js'
import { WebStartOptionsSchema, type WebStatus } from './gateway/service.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export function getDaemonControlDir(): string {
  return join(getClaudeConfigHomeDir(), 'webui')
}

export function getDaemonControlSocketPath(): string {
  return join(getDaemonControlDir(), 'control.sock')
}

export const DaemonControlRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('web.start'), options: WebStartOptionsSchema }),
  z.object({ kind: z.literal('web.stop') }),
  z.object({ kind: z.literal('web.status') }),
])

export type DaemonControlRequest = z.infer<typeof DaemonControlRequestSchema>

export type DaemonControlResponse =
  | { ok: true; status: WebStatus; daemonPid: number }
  | { ok: false; error: string }

export type DaemonControlHandlers = {
  start(options: z.infer<typeof WebStartOptionsSchema>): Promise<WebStatus>
  stop(): Promise<void>
  status(): WebStatus
}

/**
 * The supervisor's control socket.
 *
 * Same posture as the attach socket: owner-only directory and socket, so the
 * trust boundary is the filesystem. This socket can start a publicly reachable
 * server, so it must not be readable by another user.
 */
export function startDaemonControlServer(handlers: DaemonControlHandlers): {
  stop(): void
  unbind(): void
} {
  const dir = getDaemonControlDir()
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  chmodSync(dir, DIR_MODE)

  const path = getDaemonControlSocketPath()
  rmSync(path, { force: true })

  const server: Server = createServer(socket => {
    attachNdjsonReader(socket, {
      onLine(line) {
        void (async () => {
          let response: DaemonControlResponse
          try {
            const parsed = DaemonControlRequestSchema.parse(JSON.parse(line))
            switch (parsed.kind) {
              case 'web.start':
                response = {
                  ok: true,
                  status: await handlers.start(parsed.options),
                  daemonPid: process.pid,
                }
                break
              case 'web.stop':
                await handlers.stop()
                response = {
                  ok: true,
                  status: handlers.status(),
                  daemonPid: process.pid,
                }
                break
              case 'web.status':
                response = {
                  ok: true,
                  status: handlers.status(),
                  daemonPid: process.pid,
                }
                break
            }
          } catch (err) {
            response = {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }
          }
          writeNdjson(socket, response)
        })()
      },
      onError() {},
      onClose() {},
    })
  })

  server.listen(path, () => {
    try {
      chmodSync(path, FILE_MODE)
    } catch {
      // A socket we cannot lock down is worse than no socket.
      server.close()
      rmSync(path, { force: true })
    }
  })

  const release = (): void => {
    server.close()
    rmSync(path, { force: true })
  }

  return {
    stop: release,
    unbind: release,
  }
}

/** Sends one control request. Returns null when the daemon is not listening. */
export async function sendDaemonControl(
  request: DaemonControlRequest,
  timeoutMs = 60_000,
): Promise<DaemonControlResponse | null> {
  const path = getDaemonControlSocketPath()
  try {
    if (!statSync(path).isSocket()) return null
  } catch {
    return null
  }

  return new Promise(resolve => {
    const socket = createConnection(path)
    let settled = false
    const finish = (value: DaemonControlResponse | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: 'the daemon did not answer' }),
      timeoutMs,
    )

    socket.once('connect', () => writeNdjson(socket, request))
    socket.once('error', () => finish(null))
    attachNdjsonReader(socket, {
      onLine(line) {
        try {
          finish(JSON.parse(line) as DaemonControlResponse)
        } catch {
          finish({ ok: false, error: 'malformed response' })
        }
      },
      onError() {
        finish(null)
      },
      onClose() {
        finish(null)
      },
    })
  })
}
