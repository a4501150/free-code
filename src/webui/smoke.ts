import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startWireSurface } from '../server/surface.js'
import { readAttachDescriptor } from '../server/descriptor.js'
import { SURFACE_TOKEN_HEADER } from '../server/surface.js'
import { startSessiondServe } from '../sessiond/serve.js'
import { verifyPassword, writeAuthFile } from './gateway/auth.js'
import { WEBUI_CSS, WEBUI_JS } from './generated/assets.js'

type Check = { name: string; ok: boolean; detail: string }

/**
 * The sessiond gate. Proves, inside the compiled binary rather than under
 * `bun run dev`, that the embedded client, the loopback serve, the login
 * cycle, a hosted session over the wire, the WebSocket upgrade and the
 * session wire surface all work. Packaging and transport choices stand or
 * fall here.
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

  // Run against a throwaway config home: the gate must never read or write
  // the user's stored password, and the hosted session's transcript files
  // belong to this process alone. The e2e gateway suite covers the daemon,
  // the assistant bootstrap and the tunnels.
  const previousConfigDir = process.env.FREECODE_CONFIG_DIR
  const configDir = mkdtempSync(join(tmpdir(), 'webui-smoke-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  const sessionCwd = mkdtempSync(join(tmpdir(), 'webui-smoke-cwd-'))
  const serve = await startSessiondServe({})

  try {
    // 2. HTML shell.
    const html = await fetch(`${serve.url}/`)
    const htmlBody = await html.text()
    record(
      'serves html',
      html.ok && htmlBody.includes('<div id="root">'),
      `${html.status}, ${htmlBody.length} B`,
    )

    // 3. Hashed asset routes, discovered from the shell rather than guessed.
    const jsPath = htmlBody.match(/src="([^"]+\.js)"/)?.[1]
    const cssPath = htmlBody.match(/href="([^"]+\.css)"/)?.[1]
    const js = jsPath ? await fetch(`${serve.url}${jsPath}`) : undefined
    const css = cssPath ? await fetch(`${serve.url}${cssPath}`) : undefined
    record(
      'serves assets',
      Boolean(js?.ok && css?.ok),
      `js ${js?.status ?? 'missing'}, css ${css?.status ?? 'missing'}`,
    )

    // 4. The socket refuses an unauthenticated client, and the login cycle
    // (password file, cookie, csrf) works end to end.
    const wsResult = await probeWebSocket(
      `${serve.url.replace('http', 'ws')}/ws`,
    )
    record(
      'websocket guarded',
      !wsResult.opened,
      wsResult.opened ? 'accepted an unauthenticated client' : 'refused',
    )

    const password = `smoke-${randomUUID()}`
    const auth = await writeAuthFile(password)
    const login = await fetch(`${serve.url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: serve.url },
      body: JSON.stringify({ password }),
    })
    const loginBody = (await login.json().catch(() => null)) as {
      csrf?: string
    } | null
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const csrf = loginBody?.csrf ?? ''
    record(
      'login cycle',
      login.ok &&
        Boolean(cookie && csrf) &&
        (await verifyPassword(auth, password)),
      `login ${login.status}, csrf ${csrf ? 'issued' : 'missing'}`,
    )
    const headers: Record<string, string> = {
      origin: serve.url,
      cookie,
      'x-freecode-csrf': csrf,
      'content-type': 'application/json',
    }

    // 5. A hosted session: created over the wire, its stream opens with a
    // snapshot carrying its identity, a prompt is accepted, and it stops.
    const created = await fetch(`${serve.url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cwd: sessionCwd }),
    })
    const createdBody = (await created.json().catch(() => null)) as {
      session?: { processKey?: string; sessionId?: string }
    } | null
    const key = createdBody?.session?.processKey ?? ''
    const sessionId = createdBody?.session?.sessionId ?? ''
    record(
      'hosted session',
      created.ok && Boolean(key && sessionId),
      `create ${created.status}, session ${sessionId.slice(0, 8)}`,
    )

    let wireOk = false
    let wireDetail = 'no stream'
    if (key) {
      const events = await fetch(`${serve.url}/api/sessions/${key}/events`, {
        headers: { origin: serve.url, cookie },
      })
      if (events.ok && events.body) {
        const reader = events.body
          .pipeThrough(new TextDecoderStream())
          .getReader()
        const first = await reader.read()
        const snapshot = (first.value ?? '')
          .split('\n')
          .find(line => line.startsWith('data: '))
        const frame = snapshot
          ? (JSON.parse(snapshot.slice(6)) as {
              event?: { kind?: string; meta?: { sessionId?: string } }
            })
          : null
        wireOk =
          frame?.event?.kind === 'snapshot' &&
          frame.event.meta?.sessionId === sessionId
        wireDetail = wireOk
          ? 'snapshot frame matched the created session'
          : `first frame was ${snapshot?.slice(0, 40) ?? 'nothing'}`
        if (wireOk) {
          const prompt = await fetch(
            `${serve.url}/api/sessions/${key}/prompt`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                kind: 'prompt',
                commandId: randomUUID(),
                content: '/smoke-not-a-command',
                delivery: 'next',
                sessionEpoch: 0,
              }),
            },
          )
          wireDetail += `, prompt accepted (${prompt.status})`
          wireOk = prompt.ok
        }
        await reader.cancel().catch(() => {})
      } else {
        wireDetail = `events answered ${events.status}`
      }
    }
    record('session wire', wireOk, wireDetail)

    if (key) {
      const del = await fetch(`${serve.url}/api/sessions/${key}`, {
        method: 'DELETE',
        headers,
      })
      const list = await fetch(`${serve.url}/api/sessions`, {
        headers: { origin: serve.url, cookie },
      })
      const listBody = (await list.json().catch(() => null)) as {
        sessions?: Array<{ processKey?: string; live?: boolean }>
      } | null
      const stillLive = (listBody?.sessions ?? []).some(
        row => row.processKey === key && row.live,
      )
      record(
        'session stop',
        del.ok && !stillLive,
        `delete ${del.status}, live after stop: ${stillLive}`,
      )
    }

    // 6. Wire surface: listener, descriptor validation, token handshake,
    // SSE snapshot, and an unauthenticated command refused.
    const surfaceResult = await probeWireSurface()
    record('wire surface', surfaceResult.ok, surfaceResult.detail)
  } finally {
    await serve.stop()
    if (previousConfigDir === undefined) {
      delete process.env.FREECODE_CONFIG_DIR
    } else {
      process.env.FREECODE_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(sessionCwd, { recursive: true, force: true })
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
