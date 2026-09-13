import {
  defaultCloudflaredDeps,
  runCloudflared,
  type CloudflaredDeps,
} from './cloudflared.js'
import type { TunnelProvider, TunnelStartOptions } from './types.js'
import { validatePublicUrl } from './types.js'
import type { TunnelSettings } from './tunnelConfig.js'

type ApiRequest = {
  method: string
  headers: Record<string, string>
  body?: string
}
type ApiResponse = {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type CloudflareNamedDeps = CloudflaredDeps & {
  fetchImpl: (url: string, init: ApiRequest) => Promise<ApiResponse>
  apiBase: string
}

const API_ENVELOPE_FAILED = 'cloudflare API reported failure'

/**
 * Cloudflare named tunnel: a fixed hostname on your own zone.
 *
 * Everything the `cloudflared tunnel` CLI cannot do account-free is done here
 * over the API, once per start: find or create the tunnel, point the zone's
 * DNS at it, push the ingress (the loopback port changes every start), and
 * fetch the run token. The process then runs
 * `cloudflared tunnel run --token <token>`, which pulls this config from
 * Cloudflare and registers connections just like the quick tunnel does.
 *
 * Requires the `tunnel` settings block — see `tunnelConfig.ts`.
 */
export function createCloudflareNamedTunnelProvider(
  settings: TunnelSettings,
  overrides: Partial<CloudflareNamedDeps> = {},
): TunnelProvider {
  const deps: CloudflareNamedDeps = {
    ...defaultCloudflaredDeps(),
    fetchImpl: (url, init) => fetch(url, init),
    apiBase: 'https://api.cloudflare.com/client/v4',
    ...overrides,
  }
  const config = settings.config

  const host = hostnameFrom(config.url)
  const publicUrl = validatePublicUrl(`https://${host}`)
  const tunnelName = `free-code-${host}`

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const response = await deps.fetchImpl(`${deps.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apikey}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let json: any = null
    try {
      json = await response.json()
    } catch {}
    if (!response.ok || json?.success === false) {
      const errors = Array.isArray(json?.errors)
        ? json.errors
            .map((e: any) => `${e?.code ?? ''} ${e?.message ?? ''}`.trim())
            .join('; ')
        : ''
      throw new Error(
        `cloudflare API ${method} ${path} failed: ${errors || `HTTP ${response.status} ${API_ENVELOPE_FAILED}`}`,
      )
    }
    return json?.result
  }

  async function findOrCreateTunnel(): Promise<string> {
    // Singular `cfd_tunnel`, matching the API's account-resource path; the
    // plural form the docs sometimes show is rejected as an unknown variant.
    const listed = await api('GET', `/accounts/${config.accountTag}/cfd_tunnel`)
    const entries: any[] = Array.isArray(listed) ? listed : []
    const existing = entries
      .map(e => e?.tunnel ?? e)
      .find(e => e?.name === tunnelName)
    if (existing?.id) return existing.id
    const created = await api(
      'POST',
      `/accounts/${config.accountTag}/cfd_tunnel`,
      {
        name: tunnelName,
        tunnel_type: 'generic',
        config_src: 'cloudflare',
      },
    )
    if (!created?.id) throw new Error('cloudflare API created no tunnel')
    return created.id
  }

  async function resolveZoneTag(): Promise<string> {
    if (config.zoneTag) return config.zoneTag
    const labels = host.split('.')
    // Two-label zones first, then three, which covers every common public
    // suffix (example.com, example.co.uk) without shipping a suffix list.
    for (const depth of [2, 3]) {
      if (depth >= labels.length) continue
      const candidate = labels.slice(-depth).join('.')
      const zones = await api(
        'GET',
        `/zones?name=${encodeURIComponent(candidate)}`,
      )
      const zone = (Array.isArray(zones) ? zones : []).find(
        (z: any) => z?.name === candidate,
      )
      if (zone?.id) return zone.id
    }
    throw new Error(
      `no Cloudflare zone found for ${host}; set tunnel.config.zoneTag in freecode.json`,
    )
  }

  async function ensureDnsRecord(
    tunnelId: string,
    zoneTag: string,
  ): Promise<void> {
    const content = `${tunnelId}.cfargotunnel.com`
    const listed = await api(
      'GET',
      `/zones/${zoneTag}/dns_records?name=${encodeURIComponent(host)}&type=CNAME`,
    )
    const record = (Array.isArray(listed) ? listed : []).find(
      (r: any) => r?.name === host,
    )
    const body = { type: 'CNAME', name: host, content, proxied: true, ttl: 1 }
    if (!record) {
      await api('POST', `/zones/${zoneTag}/dns_records`, body)
    } else if (record.content !== content) {
      await api('PUT', `/zones/${zoneTag}/dns_records/${record.id}`, body)
    }
  }

  async function pushIngress(tunnelId: string, port: number): Promise<void> {
    await api(
      'PUT',
      `/accounts/${config.accountTag}/cfd_tunnel/${tunnelId}/config`,
      {
        config: {
          ingress: [
            { hostname: host, service: `http://127.0.0.1:${port}` },
            { service: 'http_status:404' },
          ],
        },
      },
    )
  }

  async function fetchRunToken(tunnelId: string): Promise<string> {
    const result = await api(
      'GET',
      `/accounts/${config.accountTag}/cfd_tunnel/${tunnelId}/token`,
    )
    if (!result?.token)
      throw new Error('cloudflare API returned no tunnel token')
    return result.token
  }

  return {
    name: 'cloudflared',
    async start(start: TunnelStartOptions) {
      const tunnelId = await findOrCreateTunnel()
      const zoneTag = await resolveZoneTag()
      await ensureDnsRecord(tunnelId, zoneTag)
      // The loopback port is ephemeral, so the ingress is repushed every start.
      await pushIngress(tunnelId, start.port)
      const token = await fetchRunToken(tunnelId)

      return runCloudflared(deps, ['tunnel', 'run', '--token', token], start, {
        urlPattern: null,
        publicUrl: () => publicUrl,
      })
    },
  }
}

function hostnameFrom(raw: string): string {
  const value = raw.includes('://') ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`tunnel.config.url is not a valid URL: ${raw}`)
  }
  if (!url.hostname)
    throw new Error(`tunnel.config.url has no hostname: ${raw}`)
  return url.hostname.toLowerCase()
}
