import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { registerCoordinatorAgents } from './coordinatorAgentRegistry.js'

/**
 * Returns coordinator-managed worker agent definitions.
 * Stub — the real implementation is not available in this build.
 */
export function getCoordinatorAgents(): AgentDefinition[] {
  return []
}

registerCoordinatorAgents(getCoordinatorAgents)
