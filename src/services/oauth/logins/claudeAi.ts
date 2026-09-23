/**
 * The claude.ai (Anthropic) OAuth login.
 *
 * Storage of record is secure storage (macOS keychain / .credentials.json)
 * under `claudeAiOauth`, kept cross-process-fresh by the lockfile-guarded
 * refresh in src/utils/auth.ts. The provider-config `auth.oauth` block in
 * modelSettings.json is a runtime MIRROR of that token — adapters read the
 * block; `mirrorClaudeAiOAuthToModelSettings()` rewrites it on every
 * refresh. This module is the read/mirror half of that pair; the refresh
 * machinery itself stays in src/utils/auth.ts.
 */
import { getClaudeAIOAuthTokens } from '../../../utils/oauthTokenReader.js'
import {
  readModelSettingsFile,
  writeModelSettingsFile,
} from '../../../utils/settings/modelSettings.js'
import { logError } from '../../../utils/log.js'
import { isOAuthTokenExpired } from '../client.js'
import type { OAuthTokens } from '../types.js'
import type { ProviderOAuthBlock } from './types.js'

/** Provider slot the claude.ai login owns in modelSettings.json. */
export const CLAUDE_AI_LOGIN_SLOT = 'claude-ai'

/** True when a usable claude.ai token exists in secure storage (or env/FD synthetic). */
export function claudeAiLoginLoggedIn(): boolean {
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) return false
  // A refresh token means the access token is recoverable on the request path.
  return !isOAuthTokenExpired(tokens.expiresAt ?? null) || !!tokens.refreshToken
}

export function claudeAiBlockLoggedIn(
  block: ProviderOAuthBlock | undefined,
): boolean {
  if (!block?.accessToken) return false
  return !isOAuthTokenExpired(block.expiresAt ?? null) || !!block.refreshToken
}

/**
 * Mirror a (possibly refreshed) claude.ai token into the login-owned
 * provider slot in modelSettings.json. Best-effort: only rewrites when the
 * slot exists and declares oauth auth, so a user-owned `anthropic` proxy
 * block is never touched.
 */
export function mirrorClaudeAiOAuthToModelSettings(tokens: OAuthTokens): void {
  try {
    const existing = readModelSettingsFile() ?? {}
    const providers = existing.providers as
      | Record<string, Record<string, unknown>>
      | undefined
    const claudeAiProvider = providers?.[CLAUDE_AI_LOGIN_SLOT]
    if (
      claudeAiProvider &&
      (claudeAiProvider.auth as Record<string, unknown>)?.active === 'oauth'
    ) {
      const block: ProviderOAuthBlock = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? undefined,
        expiresAt: tokens.expiresAt ?? undefined,
      }
      writeModelSettingsFile({
        providers: {
          [CLAUDE_AI_LOGIN_SLOT]: {
            ...claudeAiProvider,
            auth: { active: 'oauth', oauth: block },
          },
        },
      })
    }
  } catch (e) {
    // Non-fatal: modelSettings.json update is best-effort
    logError(e)
  }
}
