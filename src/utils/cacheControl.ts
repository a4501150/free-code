import type { QuerySource } from '../constants/querySource.js'
import {
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
} from '../bootstrap/state.js'
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
  if (
    getProviderRegistry().getDefaultProvider()?.config.type ===
      'bedrock-converse' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = isClaudeAISubscriber() && !currentLimits.isUsingOverage
    setPromptCache1hEligible(userEligible)
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
