import type { QuerySource } from '../constants/querySource.js'
import {
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
} from '../bootstrap/state.js'
import { saveCacheTtl1h } from './sessionStorage.js'
import { getInitialSettings } from './settings/settings.js'
import { isClaudeAISubscriber } from './auth.js'
import { currentLimits } from '../services/claudeAiLimits.js'
import { getProviderRegistry } from './model/providerRegistry.js'
import { isEnvTruthy } from './envUtils.js'

export function getCacheControl({
  querySource,
}: {
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
  }
}

function should1hCacheTTL(querySource?: QuerySource): boolean {
  // The wire has to honor an explicit ttl marker at all; the registry owns
  // which providers do (automatic-prefix adapters drop the markers anyway).
  if (!getProviderRegistry().supports1hCacheTTL()) return false

  if (
    getProviderRegistry().getDefaultProvider()?.config.type ===
      'bedrock-converse' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    // Operator opted in via env; the opt-in forces 1h and skips the
    // subscriber gate (a first-party billing fact).
    return true
  }

  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    // Adopt-else-compute: on resume, restoreSessionMetadata has already armed
    // the latch with the resumed session's stored decision, so the original
    // tier survives even if the inputs (async-loaded overage state) would
    // compute differently now.
    userEligible = isClaudeAISubscriber() && !currentLimits.isUsingOverage
    setPromptCache1hEligible(userEligible)
    // Persist the decision with the session so a future resume adopts it.
    saveCacheTtl1h(userEligible)
  }
  if (!userEligible) return false

  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    allowlist = getInitialSettings()?.promptCache1hAllowlist ?? [
      'repl_main_thread*',
      'sdk',
      'auto_mode',
    ]
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}
