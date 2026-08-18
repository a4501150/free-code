import { z } from 'zod'
import { createCloudflareTunnelProvider } from '../tunnel/cloudflareTunnelProvider.js'
import { createCommandTunnelProvider } from '../tunnel/commandTunnelProvider.js'
import { createLocalTunnelProvider } from '../tunnel/localTunnelProvider.js'
import type { TunnelHandle, TunnelProvider } from '../tunnel/types.js'
import { startGatewayServer, type GatewayServer } from './gatewayServer.js'
// webState imports WebStartOptionsSchema from this module, so importing it
// here at module scope would leave that schema undefined at evaluation time.

export const WebStartOptionsSchema = z.object({
  port: z.number().int().min(0).max(65535).optional(),
  tunnel: z.enum(['cloudflared', 'localtunnel', 'command', 'none']).default('cloudflared'),
  tunnelCommand: z.string().optional(),
  tunnelHost: z.string().optional(),
  subdomain: z.string().optional(),

  /**
   * Permission settings the gateway hands to every session it spawns.
   *
   * A child otherwise loads only the disk settings for its own directory, so
   * anything the operator chose here would be lost. `bypassPermissions` is
   * absent on purpose: the browser is reachable behind one password, and
   * `WebPermissionModeSchema` refuses that mode for the same reason.
   */
  permissionMode: z.enum(['default', 'acceptEdits', 'plan']).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  settings: z.string().optional(),
  settingSources: z.string().optional(),
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
    case 'cloudflared':
      return createCloudflareTunnelProvider()
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

    server = startGatewayServer({
      port: options.port,
      sessionDefaults: {
        permissionMode: options.permissionMode,
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
        settings: options.settings,
        settingSources: options.settingSources,
      },
    })
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

    // Remember how this was started, so `web restart` can ask the tunnel for
    // the same hostname instead of handing out a new URL.
    const { subdomainOf, writeWebState } = await import('./webState.js')
    writeWebState({
      options,
      subdomain: subdomainOf(status.publicUrl) ?? options.subdomain,
    })

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
