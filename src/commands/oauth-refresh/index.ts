import type { Command, LocalCommandCall } from '../../types/command.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'

function formatExpiry(expiresAt: number | null): string {
  if (!expiresAt) return 'unknown'
  const now = Date.now()
  const iso = new Date(expiresAt).toISOString()
  const deltaMs = expiresAt - now
  if (deltaMs <= 0) return `${iso} (expired)`
  const seconds = Math.round(deltaMs / 1000)
  if (seconds < 60) return `${iso} (in ${seconds}s)`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${iso} (in ${minutes}m)`
  const hours = Math.round(minutes / 60)
  return `${iso} (in ${hours}h)`
}

export const call: LocalCommandCall = async () => {
  const before = getClaudeAIOAuthTokens()
  if (!before) {
    return {
      type: 'text',
      value:
        'No OAuth session. /oauth-refresh only applies when logged in with claude.ai.',
    }
  }

  const refreshed = await checkAndRefreshOAuthTokenIfNeeded(0, true)
  const after = getClaudeAIOAuthTokens()
  const expiry = formatExpiry(after?.expiresAt ?? null)

  if (refreshed) {
    return {
      type: 'text',
      value: `OAuth token refreshed. New expiry: ${expiry}`,
    }
  }

  return {
    type: 'text',
    value:
      `OAuth token NOT refreshed. Current expiry: ${expiry}\n` +
      '(Check debug logs for the failure reason — the refresh helper logs internally.)',
  }
}

const oauthRefresh = {
  type: 'local',
  name: 'oauth-refresh',
  description: 'Force a refresh of the current claude.ai OAuth token',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default oauthRefresh
