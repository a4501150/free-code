import type { ServerWebSocket } from 'bun'
import { z } from 'zod'
import { validateUuid } from '../../utils/uuid.js'
import {
  AttachRequestBodySchema,
  type AttachEventBody,
} from '../protocol/attachSchemas.js'
import {
  WEBUI_CSS,
  WEBUI_CSS_HASH,
  WEBUI_JS,
  WEBUI_JS_HASH,
} from '../generated/assets.js'
import {
  buildClearCookie,
  buildSetCookie,
  createLoginThrottle,
  csrfMatches,
  csrfTokenFor,
  issueSessionToken,
  parseCookies,
  readAuthFile,
  verifyPassword,
  verifySessionToken,
  COOKIE_NAME,
  CSRF_HEADER,
  type AuthFile,
} from './auth.js'
import { createChildSessions } from './childSessions.js'
import {
  createSessionHub,
  type HubSubscriber,
  type SessionHub,
} from './sessionHub.js'

export type GatewayServer = {
  readonly url: string
  readonly port: number
  /** Set when a tunnel is running, so Origin and Host checks accept it. */
  setPublicUrl(url: string | null): void
  stop(): Promise<void>
}

export type StartGatewayOptions = {
  port?: number
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
}

const JS_PATH = `/assets/app.${WEBUI_JS_HASH}.js`
const CSS_PATH = `/assets/app.${WEBUI_CSS_HASH}.css`
const MAX_BODY_BYTES = 256 * 1024

type SocketData = {
  /** The cookie this socket authenticated with. CSRF tokens bind to it. */
  sessionToken: string
  processKey: string | null
  subscriber: HubSubscriber | null
}

const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attach'),
    processKey: z.string().min(1).max(200),
    csrf: z.string().min(1),
  }),
  z.object({ type: z.literal('detach') }),
  z.object({
    type: z.literal('command'),
    id: z.string().min(1).max(200),
    body: AttachRequestBodySchema,
  }),
])

function htmlShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>claude web</title>
<link rel="stylesheet" href="${CSS_PATH}">
</head>
<body>
<div id="root"></div>
<script type="module" src="${JS_PATH}"></script>
</body>
</html>
`
}

function respond(
  body: string,
  contentType: string,
  cache: 'no-store' | 'immutable',
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': contentType,
      'cache-control':
        cache === 'no-store'
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
    },
  })
}

function json(value: unknown, status = 200, extra?: Record<string, string>) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...extra,
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Starts the browser-facing server.
 *
 * Binds loopback only, always. Public reach is the tunnel's job, so this
 * listener has no reason to sit on a routable interface.
 */
export function startGatewayServer(
  options: StartGatewayOptions = {},
): GatewayServer {
  const hub: SessionHub = createSessionHub()
  const children = createChildSessions()
  const throttle = createLoginThrottle({
    perAddress: 5,
    global: 60,
    windowMs: 15 * 60 * 1000,
  })
  let publicUrl: string | null = null

  function allowedOrigins(): string[] {
    const local = [
      `http://127.0.0.1:${server.port}`,
      `http://localhost:${server.port}`,
    ]
    return publicUrl ? [...local, publicUrl] : local
  }

  /** Exact match only. A prefix check would accept evil-127.0.0.1.example. */
  function originOk(request: Request): boolean {
    const origin = request.headers.get('origin')
    // A same-origin non-CORS GET may omit Origin entirely.
    if (origin === null) return true
    if (origin === 'null') return false
    return allowedOrigins().includes(origin)
  }

  function authenticate(request: Request): {
    auth: AuthFile
    token: string
  } | null {
    const auth = readAuthFile()
    if (!auth) return null
    const token = parseCookies(request.headers.get('cookie'))[COOKIE_NAME]
    if (!token) return null
    return verifySessionToken(auth, token) ? { auth, token } : null
  }

  const server = Bun.serve<SocketData, never>({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    maxRequestBodySize: MAX_BODY_BYTES,

    async fetch(request, srv) {
      const url = new URL(request.url)

      if (url.pathname === '/ws') {
        if (!originOk(request)) {
          return new Response('bad origin', { status: 403 })
        }
        const session = authenticate(request)
        if (!session) return new Response('unauthorized', { status: 401 })
        const upgraded = srv.upgrade(request, {
          data: {
            sessionToken: session.token,
            processKey: null,
            subscriber: null,
          } satisfies SocketData,
        })
        return upgraded
          ? undefined
          : new Response('expected a websocket upgrade', { status: 400 })
      }

      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (!originOk(request)) return json({ error: 'bad_origin' }, 403)

        const address = srv.requestIP(request)?.address ?? 'unknown'
        if (!throttle.check(address)) {
          return json({ error: 'too_many_attempts' }, 429)
        }

        const auth = readAuthFile()
        if (!auth) return json({ error: 'not_configured' }, 500)

        let password = ''
        try {
          const body = (await request.json()) as { password?: unknown }
          password = typeof body.password === 'string' ? body.password : ''
        } catch {
          return json({ error: 'bad_request' }, 400)
        }

        if (!(await verifyPassword(auth, password))) {
          throttle.record(address)
          // Deliberately identical to every other failure.
          return json({ error: 'invalid_credentials' }, 401)
        }

        throttle.reset(address)
        const token = issueSessionToken(auth)
        return json({ csrf: csrfTokenFor(auth, token) }, 200, {
          'set-cookie': buildSetCookie(token, publicUrl !== null),
        })
      }

      if (url.pathname === '/api/logout' && request.method === 'POST') {
        if (!originOk(request)) return json({ error: 'bad_origin' }, 403)
        const session = authenticate(request)
        if (
          session &&
          !csrfMatches(
            session.auth,
            session.token,
            request.headers.get(CSRF_HEADER),
          )
        ) {
          return json({ error: 'bad_csrf' }, 403)
        }
        return json({ ok: true }, 200, { 'set-cookie': buildClearCookie() })
      }

      if (url.pathname === '/api/me') {
        const session = authenticate(request)
        if (!session) return json({ authenticated: false }, 401)
        return json({
          authenticated: true,
          csrf: csrfTokenFor(session.auth, session.token),
          publicUrl,
        })
      }

      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        if (!originOk(request)) return json({ error: 'bad_origin' }, 403)
        const session = authenticate(request)
        if (!session) return json({ error: 'unauthorized' }, 401)
        if (
          !csrfMatches(
            session.auth,
            session.token,
            request.headers.get(CSRF_HEADER),
          )
        ) {
          return json({ error: 'bad_csrf' }, 403)
        }

        let cwd = ''
        let resumeSessionId = ''
        try {
          const body = (await request.json()) as {
            cwd?: unknown
            resumeSessionId?: unknown
          }
          cwd = typeof body.cwd === 'string' ? body.cwd : ''
          resumeSessionId =
            typeof body.resumeSessionId === 'string' ? body.resumeSessionId : ''
        } catch {
          return json({ error: 'bad_request' }, 400)
        }

        // Resume takes its working directory from the recorded session, so a
        // client cannot pair one session ID with an unrelated directory.
        if (resumeSessionId) {
          if (!validateUuid(resumeSessionId)) {
            return json({ error: 'bad_session_id' }, 400)
          }
          const entries = await hub.list({ owns: children.owns })
          const match = entries.find(e => e.sessionId === resumeSessionId)
          if (!match) return json({ error: 'unknown_session' }, 404)
          // The client hides resume for a live row, but its list is a poll
          // behind. The CLI ownership guard is the last line, not the first.
          if (match.live) return json({ error: 'session_in_use' }, 409)
          if (!match.cwd) return json({ error: 'session_has_no_cwd' }, 422)
          cwd = match.cwd
        } else if (!cwd) {
          return json({ error: 'cwd_required' }, 400)
        }

        try {
          return json({
            session: await children.start({
              cwd,
              resumeSessionId: resumeSessionId || undefined,
            }),
          })
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : String(err) },
            500,
          )
        }
      }

      // Stopping is restricted to processes the gateway spawned. A session the
      // user started in a terminal is not the browser's to end.
      const stopMatch = url.pathname.match(/^\/api\/sessions\/(\d+)$/)
      if (stopMatch && request.method === 'DELETE') {
        if (!originOk(request)) return json({ error: 'bad_origin' }, 403)
        const session = authenticate(request)
        if (!session) return json({ error: 'unauthorized' }, 401)
        if (
          !csrfMatches(
            session.auth,
            session.token,
            request.headers.get(CSRF_HEADER),
          )
        ) {
          return json({ error: 'bad_csrf' }, 403)
        }

        const pid = Number(stopMatch[1])
        if (!children.owns(pid)) {
          return json({ error: 'not_owned' }, 403)
        }
        return json({ stopped: children.stop(pid) })
      }

      if (url.pathname === '/api/sessions') {
        const session = authenticate(request)
        if (!session) return json({ error: 'unauthorized' }, 401)
        return json({ sessions: await hub.list({ owns: children.owns }) })
      }

      switch (url.pathname) {
        case '/':
          return respond(htmlShell(), 'text/html; charset=utf-8', 'no-store')
        case JS_PATH:
          return respond(
            WEBUI_JS,
            'text/javascript; charset=utf-8',
            'immutable',
          )
        case CSS_PATH:
          return respond(WEBUI_CSS, 'text/css; charset=utf-8', 'immutable')
        default:
          return new Response('not found', {
            status: 404,
            headers: SECURITY_HEADERS,
          })
      }
    },

    websocket: {
      maxPayloadLength: MAX_BODY_BYTES,

      open(ws: ServerWebSocket<SocketData>) {
        ws.send(JSON.stringify({ type: 'ready', protocolVersion: 1 }))
      },

      async message(ws: ServerWebSocket<SocketData>, raw) {
        let parsed: unknown
        try {
          parsed = JSON.parse(String(raw))
        } catch {
          ws.send(JSON.stringify({ type: 'error', code: 'bad_json' }))
          return
        }

        const frame = ClientFrameSchema.safeParse(parsed)
        if (!frame.success) {
          ws.send(JSON.stringify({ type: 'error', code: 'bad_frame' }))
          return
        }

        if (frame.data.type === 'attach') {
          // The CSRF token is bound to the session cookie, so a cross-site
          // socket that somehow carried the cookie still cannot drive a
          // session.
          const auth = readAuthFile()
          if (!auth) {
            ws.send(JSON.stringify({ type: 'error', code: 'not_configured' }))
            return
          }
          if (!csrfMatches(auth, ws.data.sessionToken, frame.data.csrf)) {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_csrf' }))
            return
          }
          if (ws.data.subscriber) hub.unsubscribe(ws.data.subscriber)

          try {
            const { subscriber } = await hub.subscribe(
              frame.data.processKey,
              event => {
                ws.send(JSON.stringify({ type: 'event', ...event }))
              },
            )
            ws.data.subscriber = subscriber
            ws.data.processKey = frame.data.processKey
            const response = await hub.request(frame.data.processKey, {
              kind: 'subscribe',
            })
            ws.send(JSON.stringify({ type: 'attached', ok: response.ok }))
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'attach_failed',
                message: String(err instanceof Error ? err.message : err),
              }),
            )
          }
          return
        }

        if (frame.data.type === 'detach') {
          if (ws.data.subscriber) hub.unsubscribe(ws.data.subscriber)
          ws.data.subscriber = null
          ws.data.processKey = null
          return
        }

        if (!ws.data.processKey) {
          ws.send(JSON.stringify({ type: 'error', code: 'not_attached' }))
          return
        }
        // `hello` is the socket's own handshake and is never proxied: a browser
        // must not be able to re-authenticate or impersonate on the attach
        // connection.
        if (frame.data.body.kind === 'hello') {
          ws.send(JSON.stringify({ type: 'error', code: 'forbidden' }))
          return
        }

        const response = await hub.request(ws.data.processKey, frame.data.body)
        ws.send(
          JSON.stringify({
            type: 'response',
            id: frame.data.id,
            ok: response.ok,
            result: response.result,
            error: response.error,
          }),
        )
      },

      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.subscriber) hub.unsubscribe(ws.data.subscriber)
        ws.data.subscriber = null
      },
    },
  })

  // Bun types `port` as optional because a unix-socket server has none. This
  // one always binds a TCP port.
  const port = server.port ?? 0

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setPublicUrl(next) {
      publicUrl = next
    },
    async stop() {
      hub.stop()
      // Gateway-owned sessions belong to the gateway. Terminal-owned ones are
      // the user's and are deliberately left running.
      children.stopAll()
      await server.stop(true)
    },
  }
}

export type { AttachEventBody }
