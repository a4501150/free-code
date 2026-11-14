export type TunnelStartOptions = {
  port: number
  signal: AbortSignal
}

export type TunnelHandle = {
  publicUrl: string
  close(): Promise<void>
  /**
   * Settles when the tunnel process exits: a human-readable detail string on
   * an unexpected death, null when the caller's abort signal had already
   * fired (a deliberate close). Providers that do not supervise a process
   * omit it.
   */
  whenExited?: Promise<string | null>
}

export interface TunnelProvider {
  readonly name: string
  start(options: TunnelStartOptions): Promise<TunnelHandle>
}

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
