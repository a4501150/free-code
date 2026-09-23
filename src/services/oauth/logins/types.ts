/**
 * Shared types for the unified OAuth login layer.
 *
 * A "login" is an OAuth identity the user explicitly chose — via /login,
 * via migration, or by writing `auth.active: "oauth"` into a provider block
 * in modelSettings.json. Logins are the ONLY source of a "not logged in"
 * state: providers configured with apiKey/bearer/aws/gcp/azure auth never
 * prompt for /login.
 */

/** Which OAuth system backs a login. One entry per supported provider family. */
export type LoginKind = 'claude-ai' | 'codex'

/**
 * The `auth.oauth` block of a provider config (modelSettings.json), used
 * both as the codex login's storage and as the runtime mirror of the
 * claude.ai keychain token. `expiresAt` is an absolute epoch **millisecond**
 * timestamp, matching OAuthTokens.expiresAt and isOAuthTokenExpired().
 */
export type ProviderOAuthBlock = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}
