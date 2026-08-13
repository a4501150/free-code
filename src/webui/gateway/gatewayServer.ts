import {
  WEBUI_CSS,
  WEBUI_CSS_HASH,
  WEBUI_JS,
  WEBUI_JS_HASH,
} from '../generated/assets.js'

export type GatewayServer = {
  readonly url: string
  readonly port: number
  stop(): Promise<void>
}

export type StartGatewayOptions = {
  /** 0 asks the OS for a free port. */
  port?: number
}

/**
 * Security headers for every response. `default-src 'self'` with no inline
 * script is what lets the client be served over a public tunnel without also
 * granting an injected transcript string a scripting path.
 */
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

function htmlShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
): Response {
  return new Response(body, {
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

/**
 * Starts the browser-facing server.
 *
 * Binds loopback only, always. Public reach is the tunnel's job, so there is
 * never a reason for this listener to be on a routable interface.
 */
export function startGatewayServer(
  options: StartGatewayOptions = {},
): GatewayServer {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,

    fetch(request, srv) {
      const url = new URL(request.url)

      if (url.pathname === '/ws') {
        if (srv.upgrade(request)) return undefined
        return new Response('expected a websocket upgrade', { status: 400 })
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
      open(ws) {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1 }))
      },
      message() {
        // Phase 0 has no browser commands. The command allowlist lands with the
        // session hub.
      },
    },
  })

  // Bun types `port` as optional because a unix-socket server has none. This
  // one always binds a TCP port.
  const port = server.port ?? 0

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      await server.stop(true)
    },
  }
}
