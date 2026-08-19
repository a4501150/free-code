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

function deps(child: ChildProcess): CloudflareDeps {
  return {
    resolveBinary: async () => '/bin/fake',
    spawnProcess: () => child,
    startupTimeoutMs: 5000,
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
  test('resolves only after both URL and registration', async () => {
    const child = fakeChild()
    const provider = createCloudflareTunnelProvider(deps(child))
    const signal = new AbortController()

    const ready = provider.start({ port: 9999, signal: signal.signal })
    await tick()

    emitUrl(child)
    await tick()
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
