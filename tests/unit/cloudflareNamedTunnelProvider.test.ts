import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'
import {
  createCloudflareNamedTunnelProvider,
  type CloudflareNamedDeps,
} from '../../src/webui/tunnel/cloudflareNamedTunnelProvider.js'
import type { TunnelSettings } from '../../src/webui/tunnel/tunnelConfig.js'

const settings: TunnelSettings = {
  provider: 'cloudflare',
  config: {
    url: 'https://code.example.com',
    apikey: 'test-token',
    accountTag: 'acct1',
  },
}

type Call = { method: string; path: string; body: unknown }

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as { stdout: PassThrough }).stdout = new PassThrough()
  ;(child as { stderr: PassThrough }).stderr = new PassThrough()
  ;(child as { kill: (sig?: string) => boolean }).kill = () => true
  return child
}

function namedDeps(
  child: ChildProcess,
  respond: (call: Call) => unknown,
): { deps: Partial<CloudflareNamedDeps>; calls: Call[]; spawned: string[][] } {
  const calls: Call[] = []
  const spawned: string[][] = []
  return {
    calls,
    spawned,
    deps: {
      resolveBinary: async () => '/bin/fake',
      spawnProcess: (_bin, args) => {
        spawned.push([...args])
        return child
      },
      startupTimeoutMs: 5000,
      apiBase: 'https://api.test',
      fetchImpl: async (url, init) => {
        const parsed = new URL(url)
        const call: Call = {
          method: init.method,
          path: parsed.pathname + parsed.search,
          body: init.body ? JSON.parse(init.body) : undefined,
        }
        calls.push(call)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            errors: [],
            result: respond(call),
          }),
        }
      },
    },
  }
}

function emitRegistered(child: ChildProcess): void {
  child.stderr!.emit(
    'data',
    Buffer.from('INF Registered tunnel connection connIndex=0 ip=1.2.3.4\n'),
  )
}

// Let the provider's async API setup complete and subscribe to the child's
// data events before we emit anything.
const tick = () => Bun.sleep(10)

describe('cloudflare named tunnel provider', () => {
  test('creates tunnel, DNS record and ingress, then runs with the token', async () => {
    const child = fakeChild()
    const { deps, calls, spawned } = namedDeps(child, call => {
      if (call.method === 'GET' && call.path === '/accounts/acct1/cfd_tunnels')
        return []
      if (call.method === 'POST' && call.path === '/accounts/acct1/cfd_tunnels')
        return { id: 'tun-1' }
      if (call.path === '/zones?name=example.com')
        return [{ id: 'zone-1', name: 'example.com' }]
      if (
        call.method === 'GET' &&
        call.path.startsWith('/zones/zone-1/dns_records')
      )
        return []
      if (call.path === '/accounts/acct1/cfd_tunnel/tun-1/token')
        return { token: 'jwt-abc' }
      return {}
    })
    const provider = createCloudflareNamedTunnelProvider(settings, deps)

    const ready = provider.start({
      port: 9999,
      signal: new AbortController().signal,
    })
    await tick()
    emitRegistered(child)

    const handle = await ready
    expect(handle.publicUrl).toBe('https://code.example.com')
    expect(spawned[0]).toEqual(['tunnel', 'run', '--token', 'jwt-abc'])

    const created = calls.find(
      c => c.method === 'POST' && c.path === '/accounts/acct1/cfd_tunnels',
    )
    expect(created?.body).toMatchObject({
      name: 'free-code-code.example.com',
      config_src: 'cloudflare',
    })

    const dns = calls.find(
      c => c.method === 'POST' && c.path === '/zones/zone-1/dns_records',
    )
    expect(dns?.body).toMatchObject({
      type: 'CNAME',
      name: 'code.example.com',
      content: 'tun-1.cfargotunnel.com',
      proxied: true,
    })

    const ingress = calls.find(c => c.method === 'PUT')
    expect(ingress?.body).toMatchObject({
      config: {
        ingress: [
          { hostname: 'code.example.com', service: 'http://127.0.0.1:9999' },
          { service: 'http_status:404' },
        ],
      },
    })
  })

  test('reuses an existing tunnel and skips creation', async () => {
    const child = fakeChild()
    const { deps, calls } = namedDeps(child, call => {
      if (call.method === 'GET' && call.path === '/accounts/acct1/cfd_tunnels')
        return [{ tunnel: { id: 'tun-9', name: 'free-code-code.example.com' } }]
      if (call.path === '/zones?name=example.com')
        return [{ id: 'zone-1', name: 'example.com' }]
      if (
        call.method === 'GET' &&
        call.path.startsWith('/zones/zone-1/dns_records')
      )
        return [
          {
            id: 'rec-1',
            name: 'code.example.com',
            content: 'tun-9.cfargotunnel.com',
          },
        ]
      if (call.path === '/accounts/acct1/cfd_tunnel/tun-9/token')
        return { token: 'jwt-xyz' }
      return {}
    })
    const provider = createCloudflareNamedTunnelProvider(settings, deps)

    const ready = provider.start({
      port: 1234,
      signal: new AbortController().signal,
    })
    await tick()
    emitRegistered(child)

    const handle = await ready
    expect(handle.publicUrl).toBe('https://code.example.com')
    // No tunnel created, no DNS record written: everything already matched.
    expect(
      calls.some(
        c => c.method === 'POST' && c.path === '/accounts/acct1/cfd_tunnels',
      ),
    ).toBe(false)
    expect(calls.some(c => c.method === 'POST')).toBe(false)
    expect(
      calls.some(c => c.method === 'PUT' && c.path.includes('dns_records')),
    ).toBe(false)
  })

  test('missing zone fails with a hint about zoneTag', async () => {
    const child = fakeChild()
    const { deps } = namedDeps(child, call =>
      call.method === 'POST' && call.path === '/accounts/acct1/cfd_tunnels'
        ? { id: 'tun-1' }
        : [],
    )
    const provider = createCloudflareNamedTunnelProvider(settings, deps)

    await expect(
      provider.start({ port: 1, signal: new AbortController().signal }),
    ).rejects.toThrow(/zoneTag/)
  })
})
