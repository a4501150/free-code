/**
 * The Codex/ChatGPT (OpenAI) OAuth login.
 *
 * Unlike the claude.ai login (keychain as store of record), Codex tokens
 * live directly in the provider's `auth.oauth` block in modelSettings.json
 * — the provider config IS the store. The login chooses (or reuses) a
 * codex-type provider slot and keeps its token block fresh on demand via
 * the refresh-token grant.
 */
import { logError } from '../../../utils/log.js'
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../../utils/model/providerRegistry.js'
import { DEFAULT_CODEX_MODELS } from '../../../utils/model/providerPresets.js'
import {
  readModelSettingsFile,
  writeModelSettingsFile,
} from '../../../utils/settings/modelSettings.js'
import type { ProviderConfig } from '../../../utils/settings/types.js'
import { isOAuthTokenExpired } from '../client.js'
import {
  refreshCodexToken,
  runCodexOAuthFlow,
  type CodexTokens,
} from '../codex-client.js'
import type { ProviderOAuthBlock } from './types.js'

/** Default provider slot the codex login writes when none is configured. */
export const CODEX_LOGIN_SLOT = 'codex'

/** Codex wire endpoint (ChatGPT backend API) used when creating a fresh slot. */
export const CODEX_LOGIN_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Provider types served by the codex login's OpenAI account. */
export function isCodexProviderType(type: string): boolean {
  return type === 'openai-responses' || type === 'openai-chat-completions'
}

export function codexBlockLoggedIn(
  block: ProviderOAuthBlock | undefined,
): boolean {
  if (!block?.accessToken) return false
  // A refresh token means the access token is recoverable on the request path.
  return !isOAuthTokenExpired(block.expiresAt ?? null) || !!block.refreshToken
}

function readProvidersBlock(): Record<string, Partial<ProviderConfig>> {
  const settings = readModelSettingsFile()
  return (
    (settings?.providers as
      | Record<string, Partial<ProviderConfig>>
      | undefined) ?? {}
  )
}

/**
 * Persist freshly-acquired Codex tokens. Reuses an existing oauth-active
 * codex-type provider (so re-login doesn't duplicate slots), otherwise
 * creates the `codex` slot with the preset model list.
 */
export function installCodexLoginTokens(tokens: CodexTokens): void {
  const providers = readProvidersBlock()
  const slot =
    Object.entries(providers).find(
      ([, p]) =>
        isCodexProviderType(p.type ?? '') && p.auth?.active === 'oauth',
    )?.[0] ?? CODEX_LOGIN_SLOT

  const base: Partial<ProviderConfig> = providers[slot] ?? {
    type: 'openai-responses',
    baseUrl: CODEX_LOGIN_BASE_URL,
    cache: { type: 'automatic-prefix' },
    models: DEFAULT_CODEX_MODELS,
  }
  const block: ProviderOAuthBlock = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  }
  writeModelSettingsFile({
    providers: { [slot]: { ...base, auth: { active: 'oauth', oauth: block } } },
  })
  resetProviderRegistry()
}

/** Runs the browser PKCE flow and installs the resulting tokens. */
export function startCodexLogin(
  onUrlReady: (url: string) => Promise<void>,
  onManualInput?: () => Promise<string>,
): Promise<CodexTokens> {
  return runCodexOAuthFlow(onUrlReady, onManualInput).then(tokens => {
    installCodexLoginTokens(tokens)
    return tokens
  })
}

/**
 * Force-refreshes the given provider's oauth block with its refresh token
 * and writes the result back. Returns the new access token, or null when
 * the block isn't refreshable or the exchange failed.
 */
export async function refreshCodexLoginTokens(
  providerName: string,
  block: ProviderOAuthBlock,
): Promise<string | null> {
  if (!block.refreshToken) return null
  try {
    const refreshed = await refreshCodexToken(block.refreshToken)
    const provider = readProvidersBlock()[providerName]
    if (provider) {
      writeModelSettingsFile({
        providers: {
          [providerName]: {
            ...provider,
            auth: {
              active: 'oauth',
              oauth: {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresAt: refreshed.expiresAt,
              } satisfies ProviderOAuthBlock,
            },
          },
        },
      })
      resetProviderRegistry()
    }
    return refreshed.accessToken
  } catch (e) {
    logError(e)
    return null
  }
}

/** Registry slot name for a provider config, when it is registered. */
export function codexLoginSlotForConfig(config: ProviderConfig): string | null {
  for (const [name, candidate] of getProviderRegistry().getAllProviders()) {
    if (candidate === config) return name
  }
  return null
}

/**
 * Request-path freshness hook for adapters: returns the provider's oauth
 * block, force-refreshing (and rewriting modelSettings.json) first when the
 * access token is expired-or-nearly-expired and refreshable. Callers should
 * re-resolve through this on retry — the block from a pre-retry call is
 * stale after a refresh.
 */
export async function ensureCodexLoginFresh(
  config: ProviderConfig,
): Promise<ProviderOAuthBlock | null> {
  const block = config.auth?.active === 'oauth' ? config.auth.oauth : null
  if (!block?.accessToken) return null
  if (!isOAuthTokenExpired(block.expiresAt ?? null)) return block
  if (!block.refreshToken) {
    // Expired with no way to renew: surface through the normal auth-error path.
    return block
  }
  const slot = codexLoginSlotForConfig(config)
  if (!slot) return block
  const refreshed = await refreshCodexLoginTokens(slot, block)
  return refreshed
    ? {
        accessToken: refreshed,
        refreshToken: block.refreshToken,
        expiresAt: block.expiresAt,
      }
    : block
}
