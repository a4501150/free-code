/**
 * Web gateway tunnel settings — the `tunnel` block in `freecode.json`.
 *
 *     "tunnel": {
 *       "provider": "cloudflare",
 *       "config": {
 *         "url": "https://code.example.com",
 *         "apikey": "<Cloudflare API token>",
 *         "accountTag": "<zone-less account ID>",
 *         "zoneTag": "<optional, looked up from the hostname when absent>"
 *       }
 *     }
 *
 * `apikey` is a Cloudflare API token (Bearer), not the global API key. It
 * needs "Cloudflare Tunnel: Edit" on the account and "DNS: Edit" on the zone;
 * without a zoneTag it also needs "Zone: Read" to look the zone up.
 *
 * When this block is present and complete, `web start` runs a named tunnel
 * with the configured static hostname instead of a random quick-tunnel URL.
 */
import { z } from 'zod'
import { readFreecodeSettingsFile } from '../../utils/settings/freecodeSettings.js'

export const TunnelSettingsSchema = z.object({
  provider: z.literal('cloudflare'),
  config: z.object({
    url: z.string().min(1),
    apikey: z.string().min(1),
    accountTag: z.string().min(1),
    zoneTag: z.string().min(1).optional(),
  }),
})

export type TunnelSettings = z.infer<typeof TunnelSettingsSchema>

/**
 * Returns null when no `tunnel` block is configured. A block that is present
 * but incomplete throws — a typo in a credential should fail loudly, into
 * `tunnelError`, rather than silently fall back to a random URL.
 */
export function readTunnelSettings(): TunnelSettings | null {
  const raw = readFreecodeSettingsFile()?.tunnel
  if (raw === undefined) return null
  const parsed = TunnelSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`invalid "tunnel" block in freecode.json: ${detail}`)
  }
  return parsed.data
}
