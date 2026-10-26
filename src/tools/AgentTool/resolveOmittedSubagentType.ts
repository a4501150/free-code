import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * Resolve which agent type to launch when the model omits subagent_type.
 *
 * Historically this always defaulted to general-purpose, but that agent is
 * not registered in every mode (coordinator mode registers only `worker`),
 * so a defaulted call could fail with "Agent type 'general-purpose' not
 * found". Resolution order:
 *
 * 1. general-purpose when it is among the available agents (legacy default);
 * 2. the single available agent when exactly one is registered
 *    (coordinator mode: `worker`);
 * 3. otherwise return general-purpose anyway so the caller's lookup fails
 *    with the existing error that lists the available agents — with multiple
 *    candidates there is no principled guess to make.
 */
export function resolveOmittedSubagentType(
  availableAgents: AgentDefinition[],
): string {
  if (
    availableAgents.some(
      agent => agent.agentType === GENERAL_PURPOSE_AGENT.agentType,
    )
  ) {
    return GENERAL_PURPOSE_AGENT.agentType
  }
  if (availableAgents.length === 1) {
    return availableAgents[0].agentType
  }
  return GENERAL_PURPOSE_AGENT.agentType
}
