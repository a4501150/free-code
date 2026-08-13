import { randomUUID } from 'crypto'
import { createConnection } from 'net'
import { startAttachHost } from './attach/attachHost.js'
import { readAttachDescriptor } from './attach/attachDescriptor.js'
import { attachNdjsonReader, writeNdjson } from './attach/ndjsonConnection.js'
import { startGatewayServer } from './gateway/gatewayServer.js'
import { WEBUI_CSS, WEBUI_JS } from './generated/assets.js'
import { ATTACH_PROTOCOL_VERSION } from './protocol/attachSchemas.js'

type Check = { name: string; ok: boolean; detail: string }

/**
 * Phase 0 gate. Proves, inside the compiled binary rather than under
 * `bun run dev`, that the embedded client, the loopback server, the WebSocket
 * upgrade and the attach socket all work. The packaging and transport choices
 * in the plan stand or fall here.
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

  const server = startGatewayServer()
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

    // 4. WebSocket upgrade in the compiled binary.
    const wsResult = await probeWebSocket(
      `${server.url.replace('http', 'ws')}/ws`,
    )
    record('websocket upgrade', wsResult.ok, wsResult.detail)

    // 5. Attach socket: listener, descriptor validation, authenticated hello.
    const attachResult = await probeAttachHost()
    record('attach socket', attachResult.ok, attachResult.detail)
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

function probeWebSocket(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise(resolve => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      resolve({ ok: false, detail: 'timed out' })
    }, 5000)

    socket.addEventListener('message', event => {
      clearTimeout(timer)
      socket.close()
      resolve({ ok: true, detail: String(event.data).slice(0, 48) })
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, detail: 'connection error' })
    })
  })
}

async function probeAttachHost(): Promise<{ ok: boolean; detail: string }> {
  const host = startAttachHost({
    sessionId: randomUUID(),
    cwd: process.cwd(),
    entrypoint: 'webui-smoke',
  })

  if (!host) {
    return { ok: false, detail: 'unsupported platform' }
  }

  try {
    await host.ready
  } catch (err) {
    host.stop()
    return { ok: false, detail: `listen failed: ${String(err)}` }
  }

  return new Promise(resolve => {
    const finish = (ok: boolean, detail: string): void => {
      host.stop()
      resolve({ ok, detail })
    }

    // The descriptor read runs every permission and ownership check the gateway
    // will run before it trusts a socket.
    const descriptor = readAttachDescriptor(process.pid)
    if (!descriptor.ok) {
      finish(false, `descriptor rejected: ${descriptor.reason}`)
      return
    }

    const timer = setTimeout(() => finish(false, 'timed out'), 5000)
    const client = createConnection(descriptor.descriptor.socketPath, () => {
      writeNdjson(client, {
        type: 'request',
        requestId: '1',
        request: {
          kind: 'hello',
          token: descriptor.descriptor.attachToken,
          protocolVersion: ATTACH_PROTOCOL_VERSION,
        },
      })
    })

    attachNdjsonReader(client, {
      onLine(line) {
        clearTimeout(timer)
        const parsed = JSON.parse(line) as { ok?: boolean }
        client.destroy()
        finish(
          parsed.ok === true,
          parsed.ok === true ? 'handshake accepted' : `rejected: ${line}`,
        )
      },
      onError(_code, message) {
        clearTimeout(timer)
        finish(false, message)
      },
      onClose() {},
    })
  })
}
