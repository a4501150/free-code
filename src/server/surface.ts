/**
 * The session wire surface — one process's HTTP listener around a session
 * channel.
 *
 * Successor of the v1 unix-socket attach host: same seq-numbered journal with
 * bounded replay (a reconnecting client resumes from `Last-Event-ID`, or gets
 * `resync_required` and a fresh snapshot once the ring has expired), same
 * publish-on-mutation discipline, now over the single v2 trunk so the TUI,
 * the browser and (via the gateway) any tunnelled client consume exactly the
 * events defined in `session/wire.ts`. The per-session journal, publish path
 * and command handling live in `channel.ts`; this file is the listener, the
 * bearer-token check and the descriptor the gateway uses to find us.
 *
 * Loopback TCP, one bearer token (the descriptor file, 0600). The gateway
 * terminates browser auth and forwards with this token; direct local
 * consumers read the descriptor.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { WIRE_VERSION } from '../session/wire.js'
import type { WirePendingCommand } from '../session/wire.js'
import { createSessionChannel, type SessionChannel } from './channel.js'
import {
  ensureAttachDir,
  removeAttachDescriptor,
  writeAttachDescriptor,
  type AttachDescriptor,
} from './descriptor.js'
import type { SessionRuntime } from './runtime.js'

export const SURFACE_TOKEN_HEADER = 'x-freecode-surface'

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

const GET_ROUTES = new Set(['events', 'image', 'meta', 'agent_transcript'])

const POST_ROUTES = new Set([
  'prompt',
  'cancel',
  'request_respond',
  'model',
  'mode',
  'rpc',
])

const POST_KIND_MAP: Record<string, string> = {
  model: 'model_set',
  mode: 'mode_set',
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

  const channel: SessionChannel = createSessionChannel({
    sessionId: options.sessionId,
    cwd: options.cwd,
    startedAt: descriptor.startedAt,
    getCost: options.getCost,
    // The descriptor path never moves, but the ID on it must follow.
    onSessionIdChanged: sessionId => {
      descriptor.sessionId = sessionId
      try {
        writeAttachDescriptor(descriptor)
      } catch {
        // A descriptor rewrite failure loses discovery, not correctness.
      }
    },
  })

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  const fail = (
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
  ): void => {
    json(res, status, { ok: false, error: { code, message } })
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
  function sessionRoute(url: URL): { kind: string; params: string[] } | null {
    const parts = url.pathname.split('/').filter(Boolean)
    // ['v1', 'sessions', sessionId, ...rest]
    if (parts.length < 4 || parts[0] !== 'v1' || parts[1] !== 'sessions') {
      return null
    }
    if (parts[2] !== channel.sessionId) return null
    const rest = parts.slice(3)
    if (rest[0] === 'agents' && rest[1] && rest[2] === 'transcript') {
      return { kind: 'agent_transcript', params: [rest[1]] }
    }
    return { kind: rest[0]!, params: rest.slice(1) }
  }

  const server: Server = createServer((request, res) => {
    if (request.method !== 'GET' && request.method !== 'POST') {
      fail(res, 405, 'method_not_allowed', 'use GET or POST')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = sessionRoute(url)
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
        if (!GET_ROUTES.has(route.kind)) {
          fail(res, 404, 'unknown_route', 'not a GET route')
          return
        }
        channel.handleGet(request, res, route.kind, route.params, url)
        return
      }

      if (!POST_ROUTES.has(route.kind)) {
        fail(res, 404, 'unknown_route', 'not a POST route')
        return
      }
      void channel.handlePost(
        request,
        res,
        POST_KIND_MAP[route.kind] ?? route.kind,
      )
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

  let surfaceUrl = ''

  function stop(): void {
    channel.stop()
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
      return channel.hasSubscribers
    },
    registerRuntime(runtime: SessionRuntime) {
      channel.registerRuntime(runtime)
    },
    publishTranscript: () => channel.publishTranscript(),
    publishMeta: () => channel.publishMeta(),
    publishTodos: () => channel.publishTodos(),
    publishQueue: () => channel.publishQueue(),
    publishTasks: () => channel.publishTasks(),
    publishCatalog: () => channel.publishCatalog(),
    setSessionId: (sessionId: string) => channel.setSessionId(sessionId),
    stop,
  }
}

/** The pending-command shape the runtime contract exposes. */
export type { WirePendingCommand }
