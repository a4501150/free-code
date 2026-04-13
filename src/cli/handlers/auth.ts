/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  clearAuthRelatedCaches,
  performLogout,
} from '../../commands/logout/logout.js'
import { getSSLErrorHint } from '../../services/api/errorUtils.js'
import { fetchAndStoreClaudeCodeFirstTokenDate } from '../../services/api/firstTokenDate.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo,
} from '../../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import { OAuthService } from '../../services/oauth/index.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  clearOAuthTokenCache,
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isUsing3PServices,
  saveCodexOAuthTokens,
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
} from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../utils/model/providerRegistry.js'
import { writeProvidersFile } from '../../utils/model/providersFile.js'
import {
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_CODEX_MODELS,
} from '../../utils/model/legacyProviderMigration.js'
import type { ProviderConfig } from '../../utils/settings/types.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
} from '../../utils/status.js'

/**
 * Returns true if the token carries any Anthropic-issued scope (user:* or org:*).
 * Codex tokens use OpenID Connect scopes (openid, profile, email, offline_access)
 * which are not Anthropic scopes, so this returns false for them.
 */
function hasAnyAnthropicScope(scopes: string[] | undefined): boolean {
  if (!scopes?.length) return false
  return scopes.some((s) => s.startsWith('user:') || s.startsWith('org:'))
}

/**
 * Shared post-token-acquisition logic. Saves tokens, fetches profile/roles,
 * and sets up the local auth state.
 */
export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  // Clear old state before saving new credentials
  await performLogout({ clearOnboarding: false })

  // Reuse pre-fetched profile if available, otherwise fetch fresh
  const profile =
    tokens.profile ?? (await getOauthProfileFromOauthToken(tokens.accessToken))
  if (profile) {
    storeOAuthAccountInfo({
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
      displayName: profile.account.display_name || undefined,
      hasExtraUsageEnabled:
        profile.organization.has_extra_usage_enabled ?? undefined,
      billingType: profile.organization.billing_type ?? undefined,
      subscriptionCreatedAt:
        profile.organization.subscription_created_at ?? undefined,
      accountCreatedAt: profile.account.created_at,
    })
  } else if (tokens.tokenAccount) {
    // Fallback to token exchange account data when profile endpoint fails
    storeOAuthAccountInfo({
      accountUuid: tokens.tokenAccount.uuid,
      emailAddress: tokens.tokenAccount.emailAddress,
      organizationUuid: tokens.tokenAccount.organizationUuid,
    })
  }

  const storageResult = saveOAuthTokensIfNeeded(tokens)
  clearOAuthTokenCache()

// Roles and first-token-date may fail for limited-scope tokens (e.g.
  // inference-only from setup-token). They're not required for core auth.
  await fetchAndStoreUserRoles(tokens.accessToken).catch(err =>
    logForDebugging(String(err), { level: 'error' }),
  )

  if (shouldUseClaudeAIAuth(tokens.scopes)) {
    await fetchAndStoreClaudeCodeFirstTokenDate().catch(err =>
      logForDebugging(String(err), { level: 'error' }),
    )
  } else if (hasAnyAnthropicScope(tokens.scopes)) {
    // API key creation is critical for Console users — let it throw.
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(
        'Unable to create API key. The server accepted the request but did not return a key.',
      )
    }
  } else {
    // Third-party provider (e.g. OpenAI Codex) — tokens carry no Anthropic
    // scopes. Skip Anthropic API key creation entirely and store the tokens
    // in their own dedicated config slot.
    saveCodexOAuthTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt ?? Date.now() + 3600_000,
      accountId: (tokens.tokenAccount?.uuid ?? ''),
    })
  }

  // Persist provider config to providers.json so it's the single source of truth
  if (shouldUseClaudeAIAuth(tokens.scopes)) {
    // claude.ai OAuth subscriber
    writeProvidersFile({
      anthropic: {
        type: 'anthropic',
        cache: { type: 'explicit-breakpoint' },
        auth: {
          active: 'oauth',
          oauth: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
          },
        },
        models: DEFAULT_ANTHROPIC_MODELS,
      },
    })
  } else if (hasAnyAnthropicScope(tokens.scopes)) {
    // Console user — API key was created above; persist with apiKey auth
    // The API key is stored in keychain/globalConfig by createAndStoreApiKey.
    // For providers.json we use keyEnv so it resolves at runtime.
    writeProvidersFile({
      anthropic: {
        type: 'anthropic',
        cache: { type: 'explicit-breakpoint' },
        auth: {
          active: 'apiKey',
          apiKey: { keyEnv: 'ANTHROPIC_API_KEY' },
        },
        models: DEFAULT_ANTHROPIC_MODELS,
      },
    })
  } else {
    // Third-party (Codex)
    writeProvidersFile({
      codex: {
        type: 'openai-responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        cache: { type: 'automatic-prefix' },
        auth: {
          active: 'oauth',
          oauth: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
          },
        },
        models: DEFAULT_CODEX_MODELS,
      } satisfies ProviderConfig,
    })
  }
  resetProviderRegistry()

  await clearAuthRelatedCaches()
}

export async function authLogin({
  email,
  sso,
  console: useConsole,
  claudeai,
}: {
  email?: string
  sso?: boolean
  console?: boolean
  claudeai?: boolean
}): Promise<void> {
  if (useConsole && claudeai) {
    process.stderr.write(
      'Error: --console and --claudeai cannot be used together.\n',
    )
    process.exit(1)
  }

  const settings = getInitialSettings()
  // forceLoginMethod is a hard constraint (enterprise setting) — matches ConsoleOAuthFlow behavior.
  // Without it, --console selects Console; --claudeai (or no flag) selects claude.ai.
  const loginWithClaudeAi = settings.forceLoginMethod
    ? settings.forceLoginMethod === 'claudeai'
    : !useConsole
  const orgUUID = settings.forceLoginOrgUUID

  // Fast path: if a refresh token is provided via env var, skip the browser
  // OAuth flow and exchange it directly for tokens.
  const envRefreshToken = process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  if (envRefreshToken) {
    const envScopes = process.env.CLAUDE_CODE_OAUTH_SCOPES
    if (!envScopes) {
      process.stderr.write(
        'CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.\n' +
          'Set it to the space-separated scopes the refresh token was issued with\n' +
          '(e.g. "user:inference" or "user:profile user:inference user:sessions:claude_code user:mcp_servers").\n',
      )
      process.exit(1)
    }

    const scopes = envScopes.split(/\s+/).filter(Boolean)

    try {

      const tokens = await refreshOAuthToken(envRefreshToken, { scopes })
      await installOAuthTokens(tokens)

      const orgResult = await validateForceLoginOrg()
      if (!orgResult.valid) {
        process.stderr.write(orgResult.message + '\n')
        process.exit(1)
      }

      // Mark onboarding complete — interactive paths handle this via
      // the Onboarding component, but the env var path skips it.
      saveGlobalConfig(current => {
        if (current.hasCompletedOnboarding) return current
        return { ...current, hasCompletedOnboarding: true }
      })

      process.stdout.write('Login successful.\n')
      process.exit(0)
    } catch (err) {
      logError(err)
      const sslHint = getSSLErrorHint(err)
      process.stderr.write(
        `Login failed: ${errorMessage(err)}\n${sslHint ? sslHint + '\n' : ''}`,
      )
      process.exit(1)
    }
  }

  const resolvedLoginMethod = sso ? 'sso' : undefined

  const oauthService = new OAuthService()

  try {

    const result = await oauthService.startOAuthFlow(
      async url => {
        process.stdout.write('Opening browser to sign in…\n')
        process.stdout.write(`If the browser didn't open, visit: ${url}\n`)
      },
      {
        loginWithClaudeAi,
        loginHint: email,
        loginMethod: resolvedLoginMethod,
        orgUUID,
      },
    )

    await installOAuthTokens(result)

    const orgResult = await validateForceLoginOrg()
    if (!orgResult.valid) {
      process.stderr.write(orgResult.message + '\n')
      process.exit(1)
    }

    process.stdout.write('Login successful.\n')
    process.exit(0)
  } catch (err) {
    logError(err)
    const sslHint = getSSLErrorHint(err)
    process.stderr.write(
      `Login failed: ${errorMessage(err)}\n${sslHint ? sslHint + '\n' : ''}`,
    )
    process.exit(1)
  } finally {
    oauthService.cleanup()
  }
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  const hasApiKeyEnvVar =
    !!process.env.ANTHROPIC_API_KEY
  const oauthAccount = getOauthAccountInfo()
  const subscriptionType = getSubscriptionType()
  const using3P = isUsing3PServices()
  const loggedIn =
    hasToken || apiKeySource !== 'none' || hasApiKeyEnvVar || using3P

  // Determine auth method
  let authMethod: string = 'none'
  if (using3P) {
    authMethod = 'third_party'
  } else if (authTokenSource === 'claude.ai') {
    authMethod = 'claude.ai'
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'ANTHROPIC_API_KEY' || hasApiKeyEnvVar) {
    authMethod = 'api_key'
  } else if (apiKeySource === '/login managed key') {
    authMethod = 'claude.ai'
  }

  if (opts.text) {
    const properties = [
      ...buildAccountProperties(),
      ...buildAPIProviderProperties(),
    ]
    let hasAuthProperty = false
    for (const prop of properties) {
      const value =
        typeof prop.value === 'string'
          ? prop.value
          : Array.isArray(prop.value)
            ? prop.value.join(', ')
            : null
      if (value === null || value === 'none') {
        continue
      }
      hasAuthProperty = true
      if (prop.label) {
        process.stdout.write(`${prop.label}: ${value}\n`)
      } else {
        process.stdout.write(`${value}\n`)
      }
    }
    if (!hasAuthProperty && hasApiKeyEnvVar) {
      process.stdout.write('API key: ANTHROPIC_API_KEY\n')
    }
    if (!loggedIn) {
      process.stdout.write(
        'Not logged in. Run claude auth login to authenticate.\n',
      )
    }
  } else {
    const apiProvider = getProviderRegistry().getDefaultProvider()?.config.type ?? 'anthropic'
    const resolvedApiKeySource =
      apiKeySource !== 'none'
        ? apiKeySource
        : hasApiKeyEnvVar
          ? 'ANTHROPIC_API_KEY'
          : null
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod,
      apiProvider,
    }
    if (resolvedApiKeySource) {
      output.apiKeySource = resolvedApiKeySource
    }
    if (authMethod === 'claude.ai') {
      output.email = oauthAccount?.emailAddress ?? null
      output.orgId = oauthAccount?.organizationUuid ?? null
      output.orgName = oauthAccount?.organizationName ?? null
      output.subscriptionType = subscriptionType ?? null
    }

    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  try {
    await performLogout({ clearOnboarding: false })
  } catch {
    process.stderr.write('Failed to log out.\n')
    process.exit(1)
  }
  process.stdout.write('Successfully logged out from your Anthropic account.\n')
  process.exit(0)
}
