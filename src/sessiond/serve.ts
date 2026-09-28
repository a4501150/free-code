/**
 * sessiond's browser-facing server: the gateway route table over node:http,
 * with hosted sessions served in-process instead of proxied.
 *
 * The browser contract is the gateway's, route for route and gate for gate
 * (origin allowlist → cookie → CSRF → ownership): login/logout/me, session
 * list/create/delete, directory browse, the static shell, `/ws` for
 * gateway-level frames, and the per-session routes under
 * `/api/sessions/<processKey>/`. What changes is only what happens behind a
 * key: a hosted key is answered by the session's `SessionChannel` directly
 * (no token hop, no fetch proxy); an external key (a terminal session with
 * its own surface descriptor) is proxied exactly as the gateway proxied.
 *
 * node:http rather than Bun.serve so channel subscribers attach natively and
 * the proxy pipes fetch bodies into the response with request-teardown
 * semantics. `/ws` rides the repo's `ws` dependency.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { Readable } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { WIRE_VERSION, WireCommandSchema } from '../session/wire.js'
import {
  WEBUI_CSS,
  WEBUI_CSS_HASH,
  WEBUI_JS,
  WEBUI_JS_HASH,
} from '../webui/generated/assets.js'
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
} from '../webui/gateway/auth.js'
import {
  readAttachDescriptor,
  type AttachDescriptor,
} from '../server/descriptor.js'
import { SURFACE_TOKEN_HEADER } from '../server/surface.js'
import {
  listDirectories,
  PathError,
  PATH_ERROR_STATUS,
} from '../webui/gateway/directories.js'
import { validateUuid } from '../utils/uuid.js'
import { createSessionRegistry, type SessionRegistry } from './registry.js'
import type { SessionDefaults } from './registry.js'
import type { SurfaceCommandPath } from '../webui/gateway/surfaceClient.js'

export type ServeAssistantStatus =
  | { state: 'live'; pid: number; sessionId: string }
  | { state: 'starting' }
  | { state: 'gone' }

export type StartServeOptions = {
  port?: number
  sessionDefaults?: SessionDefaults
  /**
   * True while the service is bootstrapping the machine's assistant. Until
   * `setAssistant` settles it the status reads `starting`; settled without
   * an ID reads `gone`. The list stamps `role: 'assistant'` on the entry.
   */
  assistantPending?: boolean
  /**
   * Wired by the service to begin the graceful supervisor replacement.
   * Without it `POST /api/restart` answers 501.
   */
  onRestart?: () => void
}

export type SessiondServe = {
  readonly url: string
  readonly port: number
  readonly registry: SessionRegistry
  setPublicUrl(url: string | null): void
  /** Settles the assistant lifecycle: the bootstrapped id, or none. */
  setAssistant(sessionId: string | null): void
  assistantStatus(): ServeAssistantStatus
  broadcastRestartReady(frame: unknown): void
  stop(): Promise<void>
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
/** Prompts ride the command routes, and a prompt can carry images. */
const MAX_COMMAND_BODY_BYTES = 8 * 1024 * 1024

const SURFACE_COMMAND_ROUTES: SurfaceCommandPath[] = [
  'prompt',
  'cancel',
  'request_respond',
  'model',
  'mode',
  'rpc',
]

function htmlShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0d0f">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%230b0d0f'/%3E%3Ctext x='8' y='12.5' font-family='monospace' font-size='13' fill='%23f0a35e' text-anchor='middle'%3E%E2%9C%B3%3C/text%3E%3C/svg%3E">
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

type SessionRoute =
  | { key: string; route: 'events' }
  | { key: string; route: 'image' }
  | { key: string; route: 'agent_transcript'; agentId: string }
  | { key: string; route: SurfaceCommandPath }

/** `/api/sessions/<processKey>/<route>` — the browser's view of a session. */
function sessionRoute(pathname: string): SessionRoute | null {
  const parts = pathname.split('/').filter(Boolean)
  // ['api', 'sessions', <processKey>, <route>, ...]
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'sessions') {
    return null
  }
  const key = parts[2]!
  const route = parts[3]!
  if (route === 'events') return { key, route }
  if (route === 'image') return { key, route }
  if (route === 'agents' && parts[5] === 'transcript' && parts[4]) {
    return { key, route: 'agent_transcript', agentId: parts[4] }
  }
  if ((SURFACE_COMMAND_ROUTES as string[]).includes(route)) {
    return { key, route: route as SurfaceCommandPath }
  }
  return null
}

const ROUTE_KIND: Record<string, string> = {
  prompt: 'prompt',
  cancel: 'cancel',
  request_respond: 'request_respond',
  model: 'model_set',
  mode: 'mode_set',
  rpc: 'rpc',
}

function securityHeaders(
  extra: Record<string, string>,
): Record<string, string> {
  return { ...SECURITY_HEADERS, ...extra }
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  cache: 'no-store' | 'immutable',
  extra?: Record<string, string>,
): void {
  res.writeHead(status, {
    ...securityHeaders(extra ?? {}),
    'content-type': contentType,
    'cache-control':
      cache === 'no-store' ? 'no-store' : 'public, max-age=31536000, immutable',
  })
  res.end(body)
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra?: Record<string, string>,
): void {
  send(
    res,
    status,
    'application/json',
    JSON.stringify(value),
    'no-store',
    extra,
  )
}

async function readJsonBody(
  request: IncomingMessage,
  limit: number,
): Promise<
  | { ok: true; value: unknown; raw: Buffer }
  | { ok: false; status: number; code: string }
> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) return { ok: false, status: 413, code: 'body_too_large' }
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks)
  try {
    return {
      ok: true,
      value: raw.length ? JSON.parse(raw.toString('utf8')) : {},
      raw,
    }
  } catch {
    return { ok: false, status: 400, code: 'bad_json' }
  }
}

/** The channel wants a streamed body; hand it the buffered one. */
function bodyAsStream(
  raw: Buffer,
  headers: IncomingMessage['headers'],
): IncomingMessage {
  const stream = Readable.from([
    raw.length ? raw : Buffer.alloc(0),
  ]) as IncomingMessage
  ;(stream as unknown as Record<string, unknown>).headers = headers
  return stream
}

/**
 * Starts the browser-facing server. Loopback only; public reach is the
 * tunnel's job (task #12 ports the tunnel with the daemon wiring).
 */
export async function startSessiondServe(
  options: StartServeOptions = {},
): Promise<SessiondServe> {
  const registry = createSessionRegistry()
  const throttle = createLoginThrottle({
    perAddress: 5,
    global: 60,
    windowMs: 15 * 60 * 1000,
  })
  let publicUrl: string | null = null
  let assistantSessionId: string | null = null
  let assistantSettled = !options.assistantPending
  const browsers = new Set<WebSocket>()

  function allowedOrigins(port: number): string[] {
    const local = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
    return publicUrl ? [...local, publicUrl] : local
  }

  /** Exact match only. A prefix check would accept evil-127.0.0.1.example. */
  function originOk(request: IncomingMessage, port: number): boolean {
    const origin = request.headers.origin
    // A same-origin non-CORS GET may omit Origin entirely.
    if (origin === undefined) return true
    if (origin === 'null') return false
    return allowedOrigins(port).includes(origin)
  }

  function authenticate(request: IncomingMessage): {
    auth: AuthFile
    token: string
  } | null {
    const auth = readAuthFile()
    if (!auth) return null
    const token = parseCookies(request.headers.cookie ?? null)[COOKIE_NAME]
    if (!token) return null
    return verifySessionToken(auth, token) ? { auth, token } : null
  }

  function csrfOk(
    session: { auth: AuthFile; token: string },
    request: IncomingMessage,
  ): boolean {
    const header = request.headers[CSRF_HEADER]
    return csrfMatches(
      session.auth,
      session.token,
      typeof header === 'string' ? header : null,
    )
  }

  /** Key resolution: hosted entry in-process, or a verified external descriptor. */
  function resolveKey(
    key: string,
  ):
    | { kind: 'hosted'; entry: ReturnType<SessionRegistry['get']> & {} }
    | { kind: 'external'; descriptor: AttachDescriptor }
    | { kind: 'unknown' } {
    const sep = key.indexOf(':')
    if (sep > 0) {
      const pid = Number(key.slice(0, sep))
      const nonce = key.slice(sep + 1)
      if (Number.isInteger(pid) && pid > 0 && nonce) {
        const entry = registry.get(key)
        if (entry) return { kind: 'hosted', entry }
        const descriptor = readAttachDescriptor(pid)
        if (descriptor.ok && descriptor.descriptor.processNonce === nonce) {
          return { kind: 'external', descriptor: descriptor.descriptor }
        }
      }
    }
    return { kind: 'unknown' }
  }

  const server = createServer((request, res) => {
    void handle(request, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'serve_error' })
      else res.end()
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    if (!originOk(request, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    if (!authenticate(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      browsers.add(ws)
      ws.send(JSON.stringify({ type: 'ready', wireVersion: WIRE_VERSION }))
      ws.on('close', () => browsers.delete(ws))
    })
  })

  async function handle(
    request: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const method = request.method ?? 'GET'

    if (url.pathname === '/api/login' && method === 'POST') {
      if (!originOk(request, port))
        return json(res, 403, { error: 'bad_origin' })
      const address = request.socket.remoteAddress ?? 'unknown'
      if (!throttle.check(address)) {
        return json(res, 429, { error: 'too_many_attempts' })
      }
      const auth = readAuthFile()
      if (!auth) return json(res, 500, { error: 'not_configured' })
      const body = await readJsonBody(request, 64 * 1024)
      if (!body.ok) return json(res, body.status, { error: body.code })
      const password =
        typeof (body.value as { password?: unknown }).password === 'string'
          ? (body.value as { password: string }).password
          : ''
      if (!(await verifyPassword(auth, password))) {
        throttle.record(address)
        // Deliberately identical to every other failure.
        return json(res, 401, { error: 'invalid_credentials' })
      }
      throttle.reset(address)
      const token = issueSessionToken(auth)
      return json(
        res,
        200,
        { csrf: csrfTokenFor(auth, token) },
        {
          'set-cookie': buildSetCookie(token, publicUrl !== null),
        },
      )
    }

    if (url.pathname === '/api/logout' && method === 'POST') {
      if (!originOk(request, port))
        return json(res, 403, { error: 'bad_origin' })
      const session = authenticate(request)
      if (session && !csrfOk(session, request)) {
        return json(res, 403, { error: 'bad_csrf' })
      }
      return json(res, 200, { ok: true }, { 'set-cookie': buildClearCookie() })
    }

    if (url.pathname === '/api/me') {
      const session = authenticate(request)
      if (!session) return json(res, 401, { authenticated: false })
      return json(res, 200, {
        authenticated: true,
        csrf: csrfTokenFor(session.auth, session.token),
        publicUrl,
      })
    }

    // In-place replacement of the serve process is the daemon path's job
    // (task #12 ports restart); the route exists so the client never sees a
    // dead end.
    if (url.pathname === '/api/restart' && method === 'POST') {
      if (!originOk(request, port))
        return json(res, 403, { error: 'bad_origin' })
      const session = authenticate(request)
      if (!session) return json(res, 401, { error: 'unauthorized' })
      if (!csrfOk(session, request))
        return json(res, 403, { error: 'bad_csrf' })
      if (!options.onRestart) {
        return json(res, 501, { error: 'restart_not_supported' })
      }
      // The old process stays alive through the handoff; the browsers learn
      // the new URLs from the `restart_ready` frame right before it exits.
      void Promise.resolve(options.onRestart()).catch(() => {})
      return json(res, 202, { restarting: true })
    }

    if (url.pathname === '/api/sessions' && method === 'POST') {
      if (!originOk(request, port))
        return json(res, 403, { error: 'bad_origin' })
      const session = authenticate(request)
      if (!session) return json(res, 401, { error: 'unauthorized' })
      if (!csrfOk(session, request))
        return json(res, 403, { error: 'bad_csrf' })

      const body = await readJsonBody(request, 64 * 1024)
      if (!body.ok) return json(res, body.status, { error: body.code })
      const parsed = body.value as { cwd?: unknown; resumeSessionId?: unknown }
      let cwd = typeof parsed.cwd === 'string' ? parsed.cwd : ''
      const resumeSessionId =
        typeof parsed.resumeSessionId === 'string' ? parsed.resumeSessionId : ''

      // Resume takes its working directory from the recorded session, so a
      // client cannot pair one session ID with an unrelated directory.
      if (resumeSessionId) {
        if (!validateUuid(resumeSessionId)) {
          return json(res, 400, { error: 'bad_session_id' })
        }
        const entries = await registry.list()
        const match = entries.find(e => e.sessionId === resumeSessionId)
        if (!match) return json(res, 404, { error: 'unknown_session' })
        // The client hides resume for a live row, but its list is a poll
        // behind. The registry check is the last line, not the first.
        if (match.live) return json(res, 409, { error: 'session_in_use' })
        if (!match.cwd) return json(res, 422, { error: 'session_has_no_cwd' })
        cwd = match.cwd
        try {
          const entry = await registry.resume({
            sessionId: resumeSessionId,
            cwd,
            defaults: options.sessionDefaults,
          })
          return json(res, 200, {
            session: {
              processKey: entry.processKey,
              sessionId: entry.sessionId,
              cwd: entry.cwd,
            },
          })
        } catch (err) {
          if (err instanceof PathError) {
            return json(res, PATH_ERROR_STATUS[err.code], { error: err.code })
          }
          return json(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else if (!cwd) {
        return json(res, 400, { error: 'cwd_required' })
      }

      try {
        const entry = await registry.create({
          cwd,
          defaults: options.sessionDefaults,
        })
        return json(res, 200, {
          session: {
            processKey: entry.processKey,
            sessionId: entry.sessionId,
            cwd: entry.cwd,
          },
        })
      } catch (err) {
        if (err instanceof PathError) {
          return json(res, PATH_ERROR_STATUS[err.code], { error: err.code })
        }
        return json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Stopping is restricted to sessions this process hosts. A session the
    // user started in a terminal is not the browser's to end, and an
    // external row's numeric pid has nothing stoppable here anymore.
    const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (stopMatch && method === 'DELETE') {
      if (!originOk(request, port))
        return json(res, 403, { error: 'bad_origin' })
      const session = authenticate(request)
      if (!session) return json(res, 401, { error: 'unauthorized' })
      if (!csrfOk(session, request))
        return json(res, 403, { error: 'bad_csrf' })
      const stopped = registry.stop(stopMatch[1]!)
      if (!stopped && !stopMatch[1]!.includes(':')) {
        return json(res, 403, { error: 'not_owned' })
      }
      return json(res, 200, { stopped })
    }

    if (url.pathname === '/api/sessions' && method === 'GET') {
      const session = authenticate(request)
      if (!session) return json(res, 401, { error: 'unauthorized' })
      // `?q=` filters the history rows only (registry.list documents it);
      // the response shape is unchanged either way.
      const q = url.searchParams.get('q')?.trim()
      const entries = await registry.list(q ? { q } : undefined)
      return json(res, 200, {
        sessions: entries.map(entry =>
          assistantSessionId && entry.sessionId === assistantSessionId
            ? { ...entry, role: 'assistant' as const }
            : entry,
        ),
      })
    }

    // Read-only, so authentication is the whole gate, as it is for the
    // session list. The password is already an RCE credential.
    if (url.pathname === '/api/directories' && method === 'GET') {
      const session = authenticate(request)
      if (!session) return json(res, 401, { error: 'unauthorized' })
      try {
        return json(
          res,
          200,
          await listDirectories(
            url.searchParams.get('path') ?? '',
            url.searchParams.get('hidden') !== '0',
          ),
        )
      } catch (err) {
        // Answer with the code alone. A raw readdir message would report
        // which sibling paths exist.
        if (err instanceof PathError) {
          return json(res, PATH_ERROR_STATUS[err.code], { error: err.code })
        }
        return json(res, 400, { error: 'bad_path' })
      }
    }

    const proxy = sessionRoute(url.pathname)
    if (proxy) {
      if (!originOk(request, port))
        return json(res, 403, { error: 'bad_origin' })
      const session = authenticate(request)
      if (!session) return json(res, 401, { error: 'unauthorized' })

      const target = resolveKey(proxy.key)
      if (target.kind === 'unknown') {
        return json(res, 404, { error: 'unknown_session' })
      }

      if (target.kind === 'hosted') {
        const channel = target.entry.hosted.channel
        if (method === 'GET') {
          const kind =
            proxy.route === 'agent_transcript'
              ? 'agent_transcript'
              : proxy.route
          const params =
            proxy.route === 'agent_transcript' ? [proxy.agentId] : []
          channel.handleGet(request, res, kind, params, url)
          return
        }
        if (method !== 'POST') {
          return json(res, 405, { error: 'method_not_allowed' })
        }
        if (!csrfOk(session, request))
          return json(res, 403, { error: 'bad_csrf' })
        const body = await readJsonBody(request, MAX_COMMAND_BODY_BYTES)
        if (!body.ok) return json(res, body.status, { error: body.code })
        const command = WireCommandSchema.safeParse(body.value)
        if (!command.success) return json(res, 400, { error: 'bad_command' })
        const routeKind = ROUTE_KIND[proxy.route]!
        if (command.data.kind !== routeKind) {
          return json(res, 400, { error: 'wrong_route' })
        }
        await channel.handlePost(
          bodyAsStream(body.raw, request.headers),
          res,
          routeKind,
        )
        return
      }

      // External session: forward with the surface token from the descriptor.
      const d = target.descriptor
      const surfaceBase = `http://127.0.0.1:${d.port}`
      const surfaceHeaders: Record<string, string> = {
        [SURFACE_TOKEN_HEADER]: d.token,
      }

      if (proxy.route === 'events') {
        if (method !== 'GET')
          return json(res, 405, { error: 'method_not_allowed' })
        const lastEventId = request.headers['last-event-id']
        // The tear-down signal is the RESPONSE closing: an incoming GET
        // request is 'close'd as soon as its (empty) body is read, which is
        // not when the browser tab goes away.
        const abort = new AbortController()
        res.on('close', () => abort.abort())
        const upstream = await fetch(
          `${surfaceBase}/v1/sessions/${d.sessionId}/events`,
          {
            headers: {
              ...surfaceHeaders,
              ...(typeof lastEventId === 'string' && lastEventId
                ? { 'last-event-id': lastEventId }
                : {}),
            },
            signal: abort.signal,
          },
        ).catch(() => null)
        if (!upstream?.ok || !upstream.body) {
          return json(res, 502, { error: 'attach_failed' })
        }
        res.writeHead(200, {
          ...securityHeaders({}),
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
        const node = Readable.fromWeb(
          upstream.body as unknown as import('stream/web').ReadableStream,
        )
        node.on('error', () => res.end())
        node.pipe(res)
        res.on('close', () => {
          abort.abort()
          node.destroy()
        })
        return
      }

      if (proxy.route === 'image') {
        const itemId = url.searchParams.get('itemId') ?? ''
        const upstream = await fetch(
          `${surfaceBase}/v1/sessions/${d.sessionId}/image?itemId=${encodeURIComponent(itemId)}`,
          { headers: surfaceHeaders },
        ).catch(() => null)
        return proxyJsonResponse(res, upstream)
      }

      if (proxy.route === 'agent_transcript') {
        const upstream = await fetch(
          `${surfaceBase}/v1/sessions/${d.sessionId}/agents/${encodeURIComponent(proxy.agentId)}/transcript`,
          { headers: surfaceHeaders },
        ).catch(() => null)
        return proxyJsonResponse(res, upstream)
      }

      // Commands.
      if (method !== 'POST')
        return json(res, 405, { error: 'method_not_allowed' })
      if (!csrfOk(session, request))
        return json(res, 403, { error: 'bad_csrf' })
      const body = await readJsonBody(request, MAX_COMMAND_BODY_BYTES)
      if (!body.ok) return json(res, body.status, { error: body.code })
      const command = WireCommandSchema.safeParse(body.value)
      if (!command.success) return json(res, 400, { error: 'bad_command' })
      const routeKind = ROUTE_KIND[proxy.route]!
      if (command.data.kind !== routeKind) {
        return json(res, 400, { error: 'wrong_route' })
      }
      const upstream = await fetch(
        `${surfaceBase}/v1/sessions/${d.sessionId}/${proxy.route}`,
        {
          method: 'POST',
          headers: {
            ...surfaceHeaders,
            'content-type': 'application/json',
          },
          body: body.raw.toString('utf8'),
        },
      ).catch(() => null)
      return proxyJsonResponse(res, upstream)
    }

    switch (url.pathname) {
      case '/':
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          htmlShell(),
          'no-store',
        )
      case JS_PATH:
        return send(
          res,
          200,
          'text/javascript; charset=utf-8',
          WEBUI_JS,
          'immutable',
        )
      case CSS_PATH:
        return send(res, 200, 'text/css; charset=utf-8', WEBUI_CSS, 'immutable')
      default:
        res.writeHead(404, {
          ...securityHeaders({}),
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end('not found')
    }
  }

  function proxyJsonResponse(
    res: ServerResponse,
    upstream: Response | null,
  ): void {
    if (!upstream) {
      return json(res, 502, { error: 'attach_failed' })
    }
    void upstream
      .json()
      .catch((): unknown => ({
        ok: false,
        error: { code: 'bad_upstream', message: 'unreadable answer' },
      }))
      .then(answer => json(res, upstream.status, answer))
  }

  await new Promise<void>(resolve =>
    server.listen({ port: options.port ?? 0, host: '127.0.0.1' }, resolve),
  )
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    registry,
    setPublicUrl(next) {
      publicUrl = next
    },
    setAssistant(sessionId) {
      assistantSessionId = sessionId
      assistantSettled = true
    },
    assistantStatus() {
      if (!assistantSessionId) {
        return assistantSettled
          ? { state: 'gone' as const }
          : { state: 'starting' as const }
      }
      const entry = registry.bySessionId(assistantSessionId)
      return entry
        ? {
            state: 'live' as const,
            pid: process.pid,
            sessionId: entry.hosted.channel.sessionId,
          }
        : { state: 'gone' as const }
    },
    broadcastRestartReady(frame) {
      const data = JSON.stringify(frame)
      for (const ws of browsers) ws.send(data)
    },
    async stop() {
      for (const ws of browsers) ws.close()
      registry.stopAll()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
