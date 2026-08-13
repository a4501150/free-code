import { z } from 'zod'
import { createCommandTunnelProvider } from '../tunnel/commandTunnelProvider.js'
import { createLocalTunnelProvider } from '../tunnel/localTunnelProvider.js'
import type { TunnelHandle, TunnelProvider } from '../tunnel/types.js'
import { startGatewayServer, type GatewayServer } from './gatewayServer.js'

export const WebStartOptionsSchema = z.object({
  port: z.number().int().min(0).max(65535).optional(),
  tunnel: z.enum(['localtunnel', 'command', 'none']).default('localtunnel'),
  tunnelCommand: z.string().optional(),
  tunnelHost: z.string().optional(),
  subdomain: z.string().optional(),
})

export type WebStartOptions = z.infer<typeof WebStartOptionsSchema>

export type WebStatus = {
  running: boolean
  url?: string
  publicUrl?: string
  tunnel?: string
  tunnelError?: string
  startedAt?: number
}

function providerFor(options: WebStartOptions): TunnelProvider | null {
  switch (options.tunnel) {
    case 'none':
      return null
    case 'command':
      if (!options.tunnelCommand) {
        throw new Error('--tunnel command requires --tunnel-command')
      }
      return createCommandTunnelProvider(options.tunnelCommand)
    case 'localtunnel':
      return createLocalTunnelProvider({
        subdomain: options.subdomain,
        host: options.tunnelHost,
      })
  }
}

/**
 * The WebUI service: one loopback server plus an optional tunnel.
 *
 * Held by the daemon supervisor so it outlives the terminal that started it.
 */
export function createWebService() {
  let server: GatewayServer | null = null
  let tunnel: TunnelHandle | null = null
  let tunnelAbort: AbortController | null = null
  let status: WebStatus = { running: false }

  async function start(options: WebStartOptions): Promise<WebStatus> {
    if (server) return status

    server = startGatewayServer({ port: options.port })
    status = { running: true, url: server.url, startedAt: Date.now() }

    const provider = providerFor(options)
    if (provider) {
      status.tunnel = provider.name
      tunnelAbort = new AbortController()
      try {
        // Start the tunnel only after the loopback server answers, so it never
        // publishes a URL that 502s.
        const health = await fetch(`${server.url}/`)
        if (!health.ok)
          throw new Error(`loopback health check ${health.status}`)

        tunnel = await provider.start({
          port: server.port,
          signal: tunnelAbort.signal,
        })
        status.publicUrl = tunnel.publicUrl
        // Teach the origin check about the public URL, or every browser request
        // through the tunnel fails the Origin comparison.
        server.setPublicUrl(tunnel.publicUrl)
      } catch (err) {
        status.tunnelError = err instanceof Error ? err.message : String(err)
      }
    }

    return status
  }

  async function stop(): Promise<void> {
    tunnelAbort?.abort()
    await tunnel?.close().catch(() => {})
    tunnel = null
    tunnelAbort = null
    await server?.stop()
    server = null
    status = { running: false }
  }

  return {
    start,
    stop,
    get status(): WebStatus {
      return status
    },
  }
}

export type WebService = ReturnType<typeof createWebService>
