import { useMemo } from 'react'
import { useAppState } from '../state/AppState.js'
import {
  hasVoiceAuth,
  isVoiceModeFeatureEnabled,
} from '../voice/voiceModeEnabled.js'

/**
 * Combines user intent (settings.voiceEnabled) with auth + build-time feature gate.
 * Only the auth half is memoized on authVersion — it's the expensive one
 * (cold getClaudeAIOAuthTokens memoize → sync `security` spawn, ~60ms/call,
 * ~180ms total in profile v5 when token refresh cleared the cache mid-session).
 *
 * authVersion bumps on /login only. Background token refresh leaves it alone
 * (user is still authed), so the auth memo stays correct without re-eval.
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authed = useMemo(hasVoiceAuth, [authVersion])
  return userIntent && authed && isVoiceModeFeatureEnabled()
}
