import {
  defaultCloudflaredDeps,
  QUICK_TUNNEL_URL_PATTERN,
  runCloudflared,
  type CloudflaredDeps,
} from './cloudflared.js'
import type {
  TunnelHandle,
  TunnelProvider,
  TunnelStartOptions,
} from './types.js'

export type CloudflareDeps = CloudflaredDeps

/**
 * Cloudflare quick tunnel. Zero account, zero config, ~100 ms added latency.
 *
 * Downloads `cloudflared` to `~/.freecode/bin/` on first use if not in PATH.
 * Each invocation gets a random hostname; a fixed hostname needs a named
 * tunnel — see `cloudflareNamedTunnelProvider.ts`.
 *
 * `start()` resolves only after the tunnel connection is registered, so
 * consumers can trust the URL.
 */
export function createCloudflareTunnelProvider(
  overrides: Partial<CloudflareDeps> = {},
): TunnelProvider {
  const deps: CloudflareDeps = { ...defaultCloudflaredDeps(), ...overrides }

  return {
    name: 'cloudflared',
    start(start: TunnelStartOptions): Promise<TunnelHandle> {
      return runCloudflared(
        deps,
        [
          '--config',
          '/dev/null',
          'tunnel',
          '--url',
          `http://127.0.0.1:${start.port}`,
        ],
        start,
        {
          urlPattern: QUICK_TUNNEL_URL_PATTERN,
          publicUrl: scannedUrl => {
            if (!scannedUrl)
              throw new Error(
                'cloudflared registered without reporting a quick tunnel URL',
              )
            return scannedUrl
          },
        },
      )
    },
  }
}
