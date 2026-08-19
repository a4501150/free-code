import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import {
  createCloudflareTunnelProvider,
  type CloudflareDeps,
} from '../../src/webui/tunnel/cloudflareTunnelProvider.js'

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as { stdout: PassThrough }).stdout = new PassThrough()
  ;(child as { stderr: PassThrough }).stderr = new PassThrough()
  ;(child as { kill: (sig?: string) => boolean }).kill = () => true
  return child
}

function deps(
  child: ChildProcess,
  fetchFn?: typeof fetch,
): CloudflareDeps {
  return {
    resolveBinary: async () => '/bin/fake',
    spawnProcess: () => child,
    fetchUrl: fetchFn ?? (async () => new Response(null, { status: 200 })),
    startupTimeoutMs: 5000,
    probeRetryMs: 20,
  }
}

function emitUrl(
  child: ChildProcess,
  url = 'https://test-tunnel.trycloudflare.com',
): void {
  child.stderr!.emit(
    'data',
    Buffer.from(`INF Your quick Tunnel has been created!\nINF ${url}\n`),
  )
}

function emitRegistered(child: ChildProcess): void {
  child.stderr!.emit(
    'data',
    Buffer.from(
      'INF Registered tunnel connection connIndex=0 ip=1.2.3.4\n',
    ),
  )
}

// Let the provider's async setup (resolveBinary) complete and subscribe
// to the child's data events before we emit anything.
const tick = () => Bun.sleep(10)

describe('cloudflare tunnel provider', () => {
  test('resolves only after URL, registration, and a successful probe', async () => {
    const child = fakeChild()
    const provider = createCloudflareTunnelProvider(deps(child))
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()

    emitUrl(child)
    await tick()
    // URL alone does not resolve — registration is still missing
    emitRegistered(child)

    const handle = await ready
    expect(handle.publicUrl).toBe('https://test-tunnel.trycloudflare.com')
    await handle.close()
  })

  test('accepts registration before URL', async () => {
    const child = fakeChild()
    const provider = createCloudflareTunnelProvider(deps(child))
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()

    emitRegistered(child)
    await tick()
    emitUrl(child)

    const handle = await ready
    expect(handle.publicUrl).toBe('https://test-tunnel.trycloudflare.com')
    await handle.close()
  })

  test('retries a transient 502 until 200', async () => {
    const child = fakeChild()
    let calls = 0
    const fetchFn = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls++
      if (init?.signal?.aborted)
        throw new DOMException('aborted', 'AbortError')
      return new Response(null, { status: calls < 3 ? 502 : 200 })
    }
    const provider = createCloudflareTunnelProvider(
      deps(child, fetchFn as typeof fetch),
    )
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()
    emitUrl(child)
    emitRegistered(child)

    const handle = await ready
    expect(calls).toBeGreaterThanOrEqual(3)
    await handle.close()
  })

  test('rejects when cloudflared exits after URL but before registration', async () => {
    const child = fakeChild()
    const provider = createCloudflareTunnelProvider(deps(child))
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()
    emitUrl(child)
    await tick()
    child.emit('exit', 1, null)

    await expect(ready).rejects.toThrow(/exited before ready/)
  })

  test('rejects when cloudflared exits during probe', async () => {
    const child = fakeChild()
    const fetchFn = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      return new Promise<Response>((_, reject) => {
        const sig = init?.signal
        if (sig?.aborted) {
          reject(sig.reason)
          return
        }
        sig?.addEventListener('abort', () => reject(sig.reason), {
          once: true,
        })
      })
    }
    const provider = createCloudflareTunnelProvider(
      deps(child, fetchFn as typeof fetch),
    )
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()
    emitUrl(child)
    emitRegistered(child)
    await tick()
    child.emit('exit', 1, null)

    await expect(ready).rejects.toThrow(/exited before ready/)
  })

  test('rejects with a deadline error when registration never comes', async () => {
    const child = fakeChild()
    const provider = createCloudflareTunnelProvider({
      ...deps(child),
      startupTimeoutMs: 200,
    })
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()
    emitUrl(child)

    await expect(ready).rejects.toThrow(/did not become ready/)
  })

  test('rejects with a deadline error when probe never succeeds', async () => {
    const child = fakeChild()
    const fetchFn = async () => new Response(null, { status: 502 })
    const provider = createCloudflareTunnelProvider({
      ...deps(child, fetchFn as typeof fetch),
      startupTimeoutMs: 300,
    })
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()
    emitUrl(child)
    emitRegistered(child)

    await expect(ready).rejects.toThrow()
  })

  test('rejects when caller aborts during startup', async () => {
    const child = fakeChild()
    const provider = createCloudflareTunnelProvider(deps(child))
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()
    emitUrl(child)
    await tick()
    signal.abort()

    await expect(ready).rejects.toThrow(/cancelled/)
  })

  test('handles URL split across two chunks', async () => {
    const child = fakeChild()
    const provider = createCloudflareTunnelProvider(deps(child))
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()

    child.stderr!.emit('data', Buffer.from('INF https://split-'))
    child.stderr!.emit('data', Buffer.from('tunnel.trycloudflare.com\n'))
    emitRegistered(child)

    const handle = await ready
    expect(handle.publicUrl).toBe('https://split-tunnel.trycloudflare.com')
    await handle.close()
  })
})
