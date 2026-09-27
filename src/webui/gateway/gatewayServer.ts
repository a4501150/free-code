import type { ServerWebSocket } from 'bun'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { validateUuid } from '../../utils/uuid.js'
import { WIRE_VERSION, WireCommandSchema } from '../../session/wire.js'
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
import {
  bootstrapAssistantSession,
  writeAssistantResumeId,
} from './assistantSession.js'
import {
  createChildSessions,
  type ChildSessionDefaults,
  type ChildSession,
} from './childSessions.js'
import {
  readAttachDescriptor,
  type AttachDescriptor,
} from '../../server/descriptor.js'
import { SURFACE_TOKEN_HEADER } from '../../server/surface.js'
import { connectSurfaceClient } from './surfaceClient.js'
import type { SurfaceCommandPath } from './surfaceClient.js'
import { listDirectories, PathError, PATH_ERROR_STATUS } from './directories.js'
import { startGracefulRestart, type RestartReadyFrame } from './restart.js'
import { createSessionHub, type SessionHub } from './sessionHub.js'

export type GatewayAssistantStatus =
  | { state: 'live'; pid: number; sessionId: string }
  | { state: 'starting' }
  /** No assistant will come: `assistant.enabled: false`, a failed spawn, or dead. */
  | { state: 'gone' }

export type GatewayServer = {
  readonly url: string
  readonly port: number
  /** Set when a tunnel is running, so Origin and Host checks accept it. */
  setPublicUrl(url: string | null): void
  /** The machine's one assistant: live, still bootstrapping, or never coming. */
  assistantStatus(): GatewayAssistantStatus
  /** Inject an external event into the assistant as a prompt turn. */
  assistantNotify(text: string): Promise<{ ok: boolean; error?: string }>
  stop(): Promise<void>
}

export type StartGatewayOptions = {
  port?: number
  /** Permission flags every spawned session inherits. */
  sessionDefaults?: ChildSessionDefaults
  /** Release the daemon control socket so a new supervisor can bind it. */
  onUnbindControl?: () => void
  /**
   * Skip the assistant bootstrap regardless of the setting. Used by
   * `--webui-smoke`, which must not touch the user's assistant state; the
   * bootstrap itself is covered by tests/e2e/webui-gateway.test.ts.
   */
  skipAssistant?: boolean
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
/**
 * Prompts ride the command routes, and a prompt can carry images.
 */
const MAX_COMMAND_BODY_BYTES = 8 * 1024 * 1024

type SocketData = {
  /** The cookie this socket authenticated with. CSRF tokens bind to it. */
  sessionToken: string
}

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

type SessionProxyRoute =
  | { key: string; route: 'events' }
  | { key: string; route: 'image' }
  | { key: string; route: 'agent_transcript'; agentId: string }
  | { key: string; route: SurfaceCommandPath }

const SURFACE_COMMAND_ROUTES: SurfaceCommandPath[] = [
  'prompt',
  'cancel',
  'request_respond',
  'model',
  'mode',
  'rpc',
]

/** `/api/sessions/<pid:nonce>/<route>` — the browser's view of a surface. */
function sessionProxyRoute(pathname: string): SessionProxyRoute | null {
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
  const children = createChildSessions(options.sessionDefaults)
  // The assistant main chat (the machine's one assistant). Bootstrapping is
  // fire-and-forget: a slow or failed assistant spawn must not delay the
  // loopback server the tunnel health-checks.
  let assistantChild: ChildSession | null = null
  // Distinguishes "will never come" from "still coming" for web.status
  // pollers once the session list already refuses to show an assistant row.
  let assistantSettled = options.skipAssistant === true
  if (!options.skipAssistant) {
    void bootstrapAssistantSession(children).then(
      session => {
        assistantChild = session
        assistantSettled = true
      },
      () => {
        assistantSettled = true
      },
    )
  }
  const throttle = createLoginThrottle({
    perAddress: 5,
    global: 60,
    windowMs: 15 * 60 * 1000,
  })
  let publicUrl: string | null = null
  const browsers = new Set<ServerWebSocket<SocketData>>()

  function broadcast(frame: RestartReadyFrame): void {
    const data = JSON.stringify(frame)
    for (const ws of browsers) ws.send(data)
  }

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

  /**
   * Resolves a process key to its verified descriptor: the nonce in the key
   * must match the file, or the process behind the PID is not the one the
   * browser was told about.
   */
  function verifiedDescriptor(
    key: string,
  ): { descriptor: AttachDescriptor } | { response: Response } {
    const [pidText, nonce] = key.split(':')
    const pid = Number(pidText)
    if (!Number.isInteger(pid) || pid <= 0 || !nonce) {
      return { response: json({ error: 'bad_session_id' }, 400) }
    }
    const descriptor = readAttachDescriptor(pid)
    if (!descriptor.ok || descriptor.descriptor.processNonce !== nonce) {
      return { response: json({ error: 'unknown_session' }, 404) }
    }
    return { descriptor: descriptor.descriptor }
  }

  const server = Bun.serve<SocketData, never>({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    // Command bodies can carry prompt images, so this covers the whole
    // session route table, not just the small /api/* forms.
    maxRequestBodySize: MAX_COMMAND_BODY_BYTES,

    async fetch(request, srv) {
      const url = new URL(request.url)

      if (url.pathname === '/ws') {
        if (!originOk(request)) {
          return new Response('bad origin', { status: 403 })
        }
        const session = authenticate(request)
        if (!session) return new Response('unauthorized', { status: 401 })
        const upgraded = srv.upgrade(request, {
          data: { sessionToken: session.token } satisfies SocketData,
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

      // Replacing the daemon is what picks up a rebuilt binary, so the browser
      // needs it as much as the terminal does. Gated like starting a session,
      // because the password behind this authorizes command execution.
      if (url.pathname === '/api/restart' && request.method === 'POST') {
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
        startGracefulRestart({
          unbindControl: options.onUnbindControl ?? (() => {}),
          broadcast,
        })
        return json({ restarting: true }, 202)
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
          if (err instanceof PathError) {
            return json({ error: err.code }, PATH_ERROR_STATUS[err.code])
          }
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
        const entries = await hub.list({ owns: children.owns })
        return json({
          sessions: assistantChild
            ? entries.map(entry =>
                entry.sessionId === assistantChild?.sessionId
                  ? { ...entry, role: 'assistant' as const }
                  : entry,
              )
            : entries,
        })
      }

      // Read-only, so authentication is the whole gate, as it is for the
      // session list. The password is already an RCE credential: a holder can
      // start a session anywhere and approve a command. Naming a directory
      // adds no authority.
      if (url.pathname === '/api/directories' && request.method === 'GET') {
        const session = authenticate(request)
        if (!session) return json({ error: 'unauthorized' }, 401)
        try {
          return json(
            await listDirectories(
              url.searchParams.get('path') ?? '',
              url.searchParams.get('hidden') !== '0',
            ),
          )
        } catch (err) {
          // Answer with the code alone. A raw readdir message would report
          // which sibling paths exist.
          if (err instanceof PathError) {
            return json({ error: err.code }, PATH_ERROR_STATUS[err.code])
          }
          return json({ error: 'bad_path' }, 400)
        }
      }

      // v2 session proxy: the browser speaks the session wire to the
      // gateway; the gateway forwards with the surface token from the
      // descriptor. One password at the edge, one token between processes.
      const proxy = sessionProxyRoute(url.pathname)
      if (proxy) {
        if (!originOk(request)) return json({ error: 'bad_origin' }, 403)
        const session = authenticate(request)
        if (!session) return json({ error: 'unauthorized' }, 401)

        const verified = verifiedDescriptor(proxy.key)
        if ('response' in verified) return verified.response
        const d = verified.descriptor
        const surfaceBase = `http://127.0.0.1:${d.port}`
        const surfaceHeaders: Record<string, string> = {
          [SURFACE_TOKEN_HEADER]: d.token,
        }

        if (proxy.route === 'events') {
          if (request.method !== 'GET') {
            return json({ error: 'method_not_allowed' }, 405)
          }
          const lastEventId = request.headers.get('last-event-id')
          const upstream = await fetch(
            `${surfaceBase}/v1/sessions/${d.sessionId}/events`,
            {
              headers: {
                ...surfaceHeaders,
                ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
              },
              // Tearing the browser stream down must tear the child stream
              // down with it, or a background tab holds a journal subscriber.
              signal: request.signal,
            },
          ).catch(() => null)
          if (!upstream?.ok || !upstream.body) {
            return json({ error: 'attach_failed' }, 502)
          }
          return new Response(upstream.body, {
            headers: {
              ...SECURITY_HEADERS,
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
            },
          })
        }

        if (proxy.route === 'image') {
          const itemId = url.searchParams.get('itemId') ?? ''
          const upstream = await fetch(
            `${surfaceBase}/v1/sessions/${d.sessionId}/image?itemId=${encodeURIComponent(itemId)}`,
            { headers: surfaceHeaders },
          ).catch(() => null)
          if (!upstream) return json({ error: 'attach_failed' }, 502)
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              ...SECURITY_HEADERS,
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          })
        }

        if (proxy.route === 'agent_transcript') {
          const upstream = await fetch(
            `${surfaceBase}/v1/sessions/${d.sessionId}/agents/${encodeURIComponent(proxy.agentId)}/transcript`,
            { headers: surfaceHeaders },
          ).catch(() => null)
          if (!upstream) return json({ error: 'attach_failed' }, 502)
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              ...SECURITY_HEADERS,
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          })
        }

        // Commands.
        if (request.method !== 'POST') {
          return json({ error: 'method_not_allowed' }, 405)
        }
        if (
          !csrfMatches(
            session.auth,
            session.token,
            request.headers.get(CSRF_HEADER),
          )
        ) {
          return json({ error: 'bad_csrf' }, 403)
        }
        let commandBody: unknown
        try {
          commandBody = await request.json()
        } catch {
          return json({ error: 'bad_json' }, 400)
        }
        const command = WireCommandSchema.safeParse(commandBody)
        if (!command.success) return json({ error: 'bad_command' }, 400)
        const routeKind =
          proxy.route === 'model'
            ? 'model_set'
            : proxy.route === 'mode'
              ? 'mode_set'
              : proxy.route
        if (command.data.kind !== routeKind) {
          return json({ error: 'wrong_route' }, 400)
        }
        const upstream = await fetch(
          `${surfaceBase}/v1/sessions/${d.sessionId}/${proxy.route}`,
          {
            method: 'POST',
            headers: {
              ...surfaceHeaders,
              'content-type': 'application/json',
            },
            body: JSON.stringify(commandBody),
          },
        ).catch(() => null)
        if (!upstream) return json({ error: 'attach_failed' }, 502)
        const answer = await upstream.json().catch((): unknown => ({
          ok: false,
          error: { code: 'bad_upstream', message: 'unreadable answer' },
        }))
        return json(answer, upstream.status)
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
            headers: {
              ...SECURITY_HEADERS,
              'content-type': 'text/plain; charset=utf-8',
            },
          })
      }
    },

    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        browsers.add(ws)
        ws.send(JSON.stringify({ type: 'ready', wireVersion: WIRE_VERSION }))
      },

      message() {
        // v2 clients do not speak on the gateway socket. It exists for
        // gateway-level frames (restart_ready) only; session traffic is
        // HTTP commands plus the SSE proxy below.
      },

      close(ws: ServerWebSocket<SocketData>) {
        browsers.delete(ws)
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
    assistantStatus() {
      if (!assistantChild) {
        return assistantSettled
          ? { state: 'gone' as const }
          : { state: 'starting' as const }
      }
      if (!children.owns(assistantChild.pid)) return { state: 'gone' as const }
      // The descriptor carries the current ID; a child that /resume'd or
      // /clear'd itself has drifted from the ID spawn recorded.
      const descriptor = readAttachDescriptor(assistantChild.pid)
      return descriptor.ok
        ? {
            state: 'live' as const,
            pid: assistantChild.pid,
            sessionId: descriptor.descriptor.sessionId,
          }
        : { state: 'starting' as const }
    },
    async assistantNotify(text) {
      if (!assistantChild) {
        return { ok: false, error: 'no assistant session on this gateway' }
      }
      // The session list goes live off the pidfile, which the child writes
      // before its attach runtime registers. An external caller arriving in
      // that window gets `runtime_not_ready`; retrying that code (and connect
      // failures) is the correct posture for an event-injection API. Other
      // rejections — a stale epoch, a dead socket dir — are final.
      const deadline = Date.now() + 10_000
      let lastError = 'the assistant is not reachable'
      while (Date.now() < deadline) {
        let client: Awaited<ReturnType<typeof connectSurfaceClient>> | null =
          null
        try {
          client = await connectSurfaceClient(assistantChild.pid, {
            onEvent: () => {},
            onClose: () => {},
          })
          const response = await client.command('prompt', {
            kind: 'prompt',
            commandId: `notify-${randomUUID()}`,
            content: text,
            delivery: 'next',
            sessionEpoch: client.meta.sessionEpoch,
          })
          if (response.ok) return { ok: true }
          lastError = response.error?.message ?? 'submit failed'
          if (
            response.error?.code !== 'runtime_not_ready' &&
            response.error?.code !== 'unreachable'
          ) {
            return { ok: false, error: lastError }
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        } finally {
          client?.close()
        }
        await Bun.sleep(500)
      }
      return { ok: false, error: lastError }
    },
    async stop() {
      // The assistant chat survives the restart: record where it was before
      // the child dies, so the next boot resumes the same conversation.
      if (assistantChild) await writeAssistantResumeId(assistantChild.sessionId)
      // Gateway-owned sessions belong to the gateway. Terminal-owned ones are
      // the user's and are deliberately left running.
      children.stopAll()
      await server.stop(true)
    },
  }
}

export type { WireEvent } from '../../session/wire.js'
