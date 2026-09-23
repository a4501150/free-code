/**
 * Active-login resolution — the single answer to "is the user logged in?"
 *
 * Provider-agnostic: the login that applies is whichever OAuth login the
 * provider behind the default model opted into (auth.active === 'oauth'),
 * regardless of which of the supported OAuth systems backs it. Providers
 * configured with apiKey/bearer/aws/gcp/azure carry their credentials in
 * modelSettings.json and can never be in a "not logged in" state.
 */
import { getProviderRegistry } from '../../../utils/model/providerRegistry.js'
import type {
  ProviderAuthMethod,
  ProviderConfig,
} from '../../../utils/settings/types.js'
import { claudeAiBlockLoggedIn, claudeAiLoginLoggedIn } from './claudeAi.js'
import {
  codexBlockLoggedIn,
  refreshCodexLoginTokens,
  isCodexProviderType,
} from './codex.js'
import type { LoginKind } from './types.js'

export type { LoginKind } from './types.js'

export type ActiveLoginState =
  /** An OAuth login applies to the active provider. */
  | { mode: 'login'; kind: LoginKind; loggedIn: boolean }
  /** Active provider carries its own credentials — no login applies. */
  | { mode: 'configured'; authMethod: ProviderAuthMethod | 'none' }
  /**
   * Anthropic-type provider with no auth block: pre-dates the provider
   * config auth story. Resolved by the legacy env/keychain API-key chain
   * (ANTHROPIC_API_KEY, apiKeyHelper, /login managed key).
   */
  | { mode: 'legacy-anthropic' }
  /** Nothing configured at all (fresh install) — onboarding owns login. */
  | { mode: 'no-providers' }

/** The provider config serving the configured default model. */
export function getActiveProviderConfig(): ProviderConfig | null {
  const registry = getProviderRegistry()
  const defaultModel = registry.getConfiguredDefaultModel()
  if (defaultModel) {
    const resolved = registry.getProviderForModel(defaultModel)
    if (resolved) return resolved.config
  }
  return registry.getDefaultProvider()?.config ?? null
}

export function loginKindForProvider(config: ProviderConfig): LoginKind | null {
  if (config.type === 'anthropic') return 'claude-ai'
  if (isCodexProviderType(config.type)) return 'codex'
  return null
}

export function getActiveLoginState(): ActiveLoginState {
  if (getProviderRegistry().getAllProviders().size === 0) {
    return { mode: 'no-providers' }
  }
  const config = getActiveProviderConfig()
  if (!config) return { mode: 'no-providers' }

  const authMethod = config.auth?.active
  if (authMethod === 'oauth') {
    const kind = loginKindForProvider(config)
    if (!kind) return { mode: 'configured', authMethod }
    if (kind === 'codex') {
      return {
        mode: 'login',
        kind,
        loggedIn: codexBlockLoggedIn(config.auth?.oauth),
      }
    }
    // claude.ai: secure storage is the store of record; the config block is
    // its runtime mirror (also valid when hand-written by the user).
    return {
      mode: 'login',
      kind,
      loggedIn:
        claudeAiLoginLoggedIn() || claudeAiBlockLoggedIn(config.auth?.oauth),
    }
  }

  if (!authMethod) {
    return config.type === 'anthropic'
      ? { mode: 'legacy-anthropic' }
      : { mode: 'configured', authMethod: 'none' }
  }

  return { mode: 'configured', authMethod }
}

/**
 * Force-refresh the active login's tokens (401 recovery path). Only the
 * codex login refreshes here — the claude.ai login has its own
 * lockfile-guarded machinery (handleOAuth401Error).
 */
export async function refreshActiveLoginTokens(): Promise<boolean> {
  const state = getActiveLoginState()
  if (state.mode !== 'login' || state.kind !== 'codex') return false

  const registry = getProviderRegistry()
  const config = getActiveProviderConfig()
  if (!config) return false
  const slot = [...registry.getAllProviders()].find(
    ([, c]) => c === config,
  )?.[0]
  if (!slot) return false

  const block = config.auth?.oauth
  if (!block?.refreshToken) return false
  const refreshed = await refreshCodexLoginTokens(slot, {
    accessToken: block.accessToken,
    refreshToken: block.refreshToken,
    expiresAt: block.expiresAt,
  })
  return refreshed !== null
}
