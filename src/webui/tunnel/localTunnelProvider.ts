import {
  validatePublicUrl,
  type TunnelHandle,
  type TunnelProvider,
  type TunnelStartOptions,
} from './types.js'

type LocalTunnelClient = {
  url: string
  close(): void
  on(event: string, handler: (arg: unknown) => void): void
}

type LocalTunnelModule = (options: {
  port: number
  subdomain?: string
  host?: string
}) => Promise<LocalTunnelClient>

/**
 * LocalTunnel.
 *
 * Note for anyone debugging a "it worked yesterday" report: the public
 * localtunnel.me service shows a visitor interstitial and is frequently
 * unavailable. `--tunnel-host` points at a self-hosted server, and the command
 * provider covers everything else.
 */
export function createLocalTunnelProvider(options: {
  subdomain?: string
  host?: string
}): TunnelProvider {
  return {
    name: 'localtunnel',
    async start({ port, signal }: TunnelStartOptions): Promise<TunnelHandle> {
      const module = (await import('localtunnel')) as unknown as {
        default: LocalTunnelModule
      }
      const client = await module.default({
        port,
        ...(options.subdomain ? { subdomain: options.subdomain } : {}),
        ...(options.host ? { host: options.host } : {}),
      })

      const publicUrl = validatePublicUrl(client.url)

      const onAbort = (): void => {
        client.close()
      }
      signal.addEventListener('abort', onAbort, { once: true })

      return {
        publicUrl,
        async close() {
          signal.removeEventListener('abort', onAbort)
          client.close()
        },
      }
    },
  }
}
