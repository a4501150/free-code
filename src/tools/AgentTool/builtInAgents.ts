import { feature } from 'bun:bundle'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getCoordinatorAgents } from '../../coordinator/coordinatorAgentRegistry.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorModeGate.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { ADVISOR_AGENT } from './built-in/advisorAgent.js'
import { FORK_AGENT, isForkAgentEnabled } from './built-in/forkAgent.js'
import { getAdvisorConfig } from '../../utils/advisor.js'
import {
  getPlanAgentConfig,
  isBuiltInPlanAgentEnabled,
} from '../../utils/planAgent.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

export function getBuiltInAgents(): AgentDefinition[] {
  // Allow disabling all built-in agents via env var (useful for SDK users who want a blank slate)
  // Only applies in noninteractive mode (SDK/API usage)
  if (
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

  if (isCoordinatorMode()) {
    return getCoordinatorAgents()
  }

  // One built-in by default. Helper personas (Explore, statusline-setup,
  // claude-code-guide) were cut: general-purpose carries their guidance.
  const agents: AgentDefinition[] = [GENERAL_PURPOSE_AGENT]

  if (isForkAgentEnabled()) {
    agents.push(FORK_AGENT)
  }

  if (isBuiltInPlanAgentEnabled()) {
    const planConfig = getPlanAgentConfig()
    agents.push({
      ...PLAN_AGENT,
      ...(planConfig.planModel ? { model: planConfig.planModel } : {}),
    })
  }

  if (feature('VERIFY_PLAN')) {
    agents.push(VERIFICATION_AGENT)
  }

  const advisorConfig = getAdvisorConfig()
  if (advisorConfig.enabled && advisorConfig.advisorModel) {
    agents.push({
      ...ADVISOR_AGENT,
      model: advisorConfig.advisorModel,
    })
  }

  return agents
}
