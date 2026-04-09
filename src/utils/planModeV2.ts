import { getRateLimitTier, getSubscriptionType } from './auth.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

export function getPlanModeV2AgentCount(): number {
  // Environment variable override takes precedence
  if (process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT) {
    const count = parseInt(process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT, 10)
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()

  if (
    subscriptionType === 'max' &&
    rateLimitTier === 'default_claude_max_20x'
  ) {
    return 3
  }

  if (subscriptionType === 'enterprise' || subscriptionType === 'team') {
    return 3
  }

  return 1
}

export function getPlanModeV2ExploreAgentCount(): number {
  if (process.env.CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT) {
    const count = parseInt(
      process.env.CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT,
      10,
    )
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  return 3
}

/**
 * Check if plan mode interview phase is enabled.
 *
 * Config: always on, envVar=CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE can disable
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  const env = process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE
  if (isEnvDefinedFalsy(env)) return false
  return getInitialSettings()?.planModeInterviewPhase ?? false
}

