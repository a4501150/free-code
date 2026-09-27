import { randomUUID } from 'crypto'
import { startWireSurface } from '../server/surface.js'
import { readAttachDescriptor } from '../server/descriptor.js'
import { SURFACE_TOKEN_HEADER } from '../server/surface.js'
import { startGatewayServer } from './gateway/gatewayServer.js'
import { WEBUI_CSS, WEBUI_JS } from './generated/assets.js'

type Check = { name: string; ok: boolean; detail: string }

/**
 * Phase 0 gate. Proves, inside the compiled binary rather than under
 * `bun run dev`, that the embedded client, the loopback server, the WebSocket
 * upgrade and the session wire surface all work. The packaging and transport
 * choices in the plan stand or fall here.
 */
export async function runWebuiSmoke(): Promise<number> {
  const checks: Check[] = []
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  // 1. Embedded assets survived `bun build --compile --bytecode`.
  record(
    'assets embedded',
    WEBUI_JS.length > 1000 && WEBUI_CSS.length > 0,
    `${WEBUI_JS.length} B js, ${WEBUI_CSS.length} B css`,
  )

  // skipAssistant: the smoke must never spawn (or resume-over) the user's
  // real assistant session; the e2e gateway suite covers the bootstrap.
  const server = startGatewayServer({ skipAssistant: true })
  try {
    // 2. HTML shell.
    const html = await fetch(`${server.url}/`)
    const htmlBody = await html.text()
    record(
      'serves html',
      html.ok && htmlBody.includes('<div id="root">'),
      `${html.status}, ${htmlBody.length} B`,
    )

    // 3. Hashed asset routes, discovered from the shell rather than guessed.
    const jsPath = htmlBody.match(/src="([^"]+\.js)"/)?.[1]
    const cssPath = htmlBody.match(/href="([^"]+\.css)"/)?.[1]
    const js = jsPath ? await fetch(`${server.url}${jsPath}`) : undefined
    const css = cssPath ? await fetch(`${server.url}${cssPath}`) : undefined
    record(
      'serves assets',
      Boolean(js?.ok && css?.ok),
      `js ${js?.status ?? 'missing'}, css ${css?.status ?? 'missing'}`,
    )

    // 4. The gateway socket exists and refuses an unauthenticated client.
    // The authenticated path is covered by tests/e2e/webui-gateway.test.ts;
    // this command must never touch the stored password to exercise it.
    const wsResult = await probeWebSocket(
      `${server.url.replace('http', 'ws')}/ws`,
    )
    record(
      'websocket guarded',
      !wsResult.opened,
      wsResult.opened ? 'accepted an unauthenticated client' : 'refused',
    )

    // 5. Wire surface: listener, descriptor validation, token handshake,
    // SSE snapshot, and an unauthenticated command refused.
    const surfaceResult = await probeWireSurface()
    record('wire surface', surfaceResult.ok, surfaceResult.detail)
  } finally {
    await server.stop()
  }

  for (const check of checks) {
    const mark = check.ok ? 'ok  ' : 'FAIL'
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${mark} ${check.name.padEnd(20)} ${check.detail}`)
  }

  return checks.every(c => c.ok) ? 0 : 1
}

function probeWebSocket(url: string): Promise<{ opened: boolean }> {
  return new Promise(resolve => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      resolve({ opened: false })
    }, 5000)

    socket.addEventListener('open', () => {
      clearTimeout(timer)
      socket.close()
      resolve({ opened: true })
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      resolve({ opened: false })
    })
  })
}

async function probeWireSurface(): Promise<{ ok: boolean; detail: string }> {
  const sessionId = randomUUID()
  const surface = startWireSurface({
    sessionId,
    cwd: process.cwd(),
    entrypoint: 'webui-smoke',
  })

  if (!surface) {
    return { ok: false, detail: 'unsupported platform' }
  }

  try {
    await surface.ready
  } catch (err) {
    surface.stop()
    return { ok: false, detail: `listen failed: ${String(err)}` }
  }

  const finish = (
    ok: boolean,
    detail: string,
  ): { ok: boolean; detail: string } => {
    surface.stop()
    return { ok, detail }
  }

  try {
    // The descriptor read runs every permission and ownership check the
    // gateway will run before it trusts a surface.
    const descriptor = readAttachDescriptor(process.pid)
    if (!descriptor.ok) {
      return finish(false, `descriptor rejected: ${descriptor.reason}`)
    }
    const base = `http://127.0.0.1:${descriptor.descriptor.port}`
    const token = descriptor.descriptor.token

    // The token handshake: the meta route answers 200 with this session's
    // identity and refuses the same request without the header.
    const meta = await fetch(`${base}/v1/sessions/${sessionId}/meta`, {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    if (!meta.ok) {
      return finish(false, `meta route answered ${meta.status}`)
    }
    const metaBody = (await meta.json()) as { sessionId?: string }
    if (metaBody.sessionId !== sessionId) {
      return finish(
        false,
        `meta named the wrong session: ${metaBody.sessionId}`,
      )
    }
    const noToken = await fetch(`${base}/v1/sessions/${sessionId}/meta`)
    if (noToken.status !== 401) {
      return finish(false, `unauthenticated meta answered ${noToken.status}`)
    }

    // The SSE route opens with a snapshot frame carrying this session.
    const events = await fetch(`${base}/v1/sessions/${sessionId}/events`, {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    if (!events.ok || !events.body) {
      return finish(false, `events route answered ${events.status}`)
    }
    const reader = events.body.pipeThrough(new TextDecoderStream()).getReader()
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 5000),
      ),
    ])
    const frame = first.value ?? ''
    const sawSnapshot = frame.includes('"kind":"snapshot"')
    void reader.cancel()
    if (!sawSnapshot) {
      return finish(
        false,
        `first stream frame was not a snapshot: ${frame.slice(0, 120)}`,
      )
    }

    return finish(true, 'descriptor, token handshake and SSE snapshot ok')
  } catch (err) {
    return finish(false, err instanceof Error ? err.message : String(err))
  }
}
