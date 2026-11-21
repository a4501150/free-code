import type { ProviderAuthConfig } from '../../../utils/settings/types.js'

// Shared credential-resolution helpers for the provider adapters, so the
// token/keyEnv fallback chains can't drift between adapters.

export function resolveBearerToken(
  auth?: ProviderAuthConfig,
): string | undefined {
  const token =
    auth?.bearer?.token ||
    (auth?.bearer?.tokenEnv ? process.env[auth.bearer.tokenEnv] : undefined)
  return token || undefined
}

export function resolveApiKey(auth?: ProviderAuthConfig): string | undefined {
  const key =
    auth?.apiKey?.key ||
    (auth?.apiKey?.keyEnv ? process.env[auth.apiKey.keyEnv] : undefined)
  return key || undefined
}
