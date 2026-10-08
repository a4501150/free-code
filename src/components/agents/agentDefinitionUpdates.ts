/**
 * Shared AppState updaters for the agent-definitions store writes the
 * /agents host adapters perform (delete, edit, create). Each rebuilds the
 * active set from the resulting allAgents list via getActiveAgentsFromList.
 */
import type { AppState } from '../../state/AppStateStore.js'
import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import {
  type AgentDefinition,
  getActiveAgentsFromList,
} from '../../tools/AgentTool/loadAgentsDir.js'

/** Edit payload for withAgentUpdated — matches the panel's AgentEditorChanges. */
export type AgentUpdateChanges = {
  agentType: string
  tools?: string[]
  color?: AgentColorName
  model?: string
}

function withAgentDefinitions(
  state: AppState,
  allAgents: AgentDefinition[],
): AppState {
  return {
    ...state,
    agentDefinitions: {
      ...state.agentDefinitions,
      activeAgents: getActiveAgentsFromList(allAgents),
      allAgents,
    },
  }
}

export function withAgentDeleted(
  state: AppState,
  agent: AgentDefinition,
): AppState {
  return withAgentDefinitions(
    state,
    state.agentDefinitions.allAgents.filter(
      a => !(a.agentType === agent.agentType && a.source === agent.source),
    ),
  )
}

export function withAgentUpdated(
  state: AppState,
  { agentType, tools, color, model }: AgentUpdateChanges,
): AppState {
  return withAgentDefinitions(
    state,
    state.agentDefinitions.allAgents.map(a =>
      a.agentType === agentType
        ? {
            ...a,
            tools: tools ?? a.tools,
            color,
            model: model ?? a.model,
          }
        : a,
    ),
  )
}

export function withAgentCreated(
  state: AppState,
  agent: AgentDefinition,
): AppState {
  if (!agent) return state
  return withAgentDefinitions(
    state,
    state.agentDefinitions.allAgents.concat(agent),
  )
}
