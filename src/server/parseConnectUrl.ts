/**
 * Parse a cc:// or cc+unix:// connect URL into server URL and auth token.
 * Stub — the real implementation is not available in this build.
 */
export function parseConnectUrl(url: string): {
  serverUrl: string
  authToken?: string
} {
  const u = new URL(url.replace(/^cc(\+unix)?:\/\//, 'http://'))
  const authToken = u.searchParams.get('token') ?? undefined
  u.searchParams.delete('token')
  return { serverUrl: u.toString(), authToken }
}
