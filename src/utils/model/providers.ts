import { isEnvTruthy } from '../envUtils.js'
import { getProviderRegistry } from './providerRegistry.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai'

/**
 * Get the current API provider.
 *
 * Now backed by the provider registry. The registry is lazily initialized
 * from settings.providers (if present) or auto-migrated from legacy env vars.
 * This function returns the legacy APIProvider string for backward compat.
 */
export function getAPIProvider(): APIProvider {
  return getProviderRegistry().getLegacyAPIProvider()
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider()
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com.
 *
 * Now backed by the provider registry — checks the default provider's baseUrl.
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const registry = getProviderRegistry()
  const defaultProvider = registry.getDefaultProvider()
  if (!defaultProvider) {
    // Fallback to original env var check
    const baseUrl = process.env.ANTHROPIC_BASE_URL
    if (!baseUrl) return true
    try {
      return new URL(baseUrl).host === 'api.anthropic.com'
    } catch {
      return false
    }
  }
  if (defaultProvider.config.type !== 'anthropic') return false
  const baseUrl = defaultProvider.config.baseUrl
  if (!baseUrl) return true
  try {
    return new URL(baseUrl).host === 'api.anthropic.com'
  } catch {
    return false
  }
}
