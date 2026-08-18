export type TunnelStartOptions = {
  port: number
  signal: AbortSignal
}

export type TunnelHandle = {
  publicUrl: string
  close(): Promise<void>
}

export interface TunnelProvider {
  readonly name: string
  start(options: TunnelStartOptions): Promise<TunnelHandle>
}

export type TunnelKind = 'cloudflared' | 'localtunnel' | 'command' | 'none'

/**
 * Only an HTTPS URL is acceptable. The tunnel supplies the transport security
 * for a password that authorizes command execution, so a plain-HTTP tunnel
 * would put that password on the wire in clear text.
 */
export function validatePublicUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`tunnel returned an unparseable URL: ${trimmed}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`tunnel URL must be https, got ${url.protocol}`)
  }
  // Normalize away a trailing slash so Origin comparisons match exactly.
  return url.origin
}
