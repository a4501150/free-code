import {
  getClaudeAIOAuthTokens,
  isAnthropicAuthEnabled,
} from '../utils/auth.js'

/**
 * Voice mode is compiled in unconditionally now — this gate always passes.
 * Kept for call sites that still consult a feature gate (command
 * registration, config UI).
 */
export function isVoiceModeFeatureEnabled(): boolean {
  return true
}

/**
 * Auth-only check for voice mode. Returns true when the user has a valid
 * Anthropic OAuth token. Backed by the memoized getClaudeAIOAuthTokens —
 * first call spawns `security` on macOS (~20-50ms), subsequent calls are
 * cache hits. The memoize clears on token refresh (~once/hour), so one
 * cold spawn per refresh is expected. Cheap enough for usage-time checks.
 */
export function hasVoiceAuth(): boolean {
  // Voice mode requires Anthropic OAuth — it uses the voice_stream
  // endpoint on claude.ai which is not available with API keys,
  // Bedrock, Vertex, or Foundry.
  if (!isAnthropicAuthEnabled()) {
    return false
  }
  // isAnthropicAuthEnabled only checks the auth *provider*, not whether
  // a token exists. Without this check, the voice UI renders but
  // connectVoiceStream fails silently when the user isn't logged in.
  const tokens = getClaudeAIOAuthTokens()
  return Boolean(tokens?.accessToken)
}

/**
 * Full runtime check for voice mode: auth (the build-time gate is gone —
 * voice mode is always compiled in). Callers: `/voice` (voice.ts,
 * voice/index.ts), VoiceModeNotice — command-time
 * paths where a fresh keychain read is acceptable. For React render
 * paths use useVoiceEnabled() instead (memoizes the auth half).
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceModeFeatureEnabled()
}
