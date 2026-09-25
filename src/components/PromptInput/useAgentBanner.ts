import { useAppState, useAppStateStore } from '../../state/AppState.js'
import { getActiveAgentForInput } from '../../state/selectors.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
  getAgentColor,
} from '../../tools/AgentTool/agentColorManager.js'
import { getStandaloneAgentName } from '../../utils/standaloneAgent.js'
import type { Theme } from '../../utils/theme.js'

type AgentBannerInfo = {
  text: string
  bgColor: keyof Theme
} | null

/**
 * Hook that returns banner information for the viewed background agent,
 * standalone agent, or --agent CLI context.
 * - Viewing a background agent (CoordinatorTaskPanel): Returns agent name
 *   with its color
 * - Standalone agent: Returns agent name with their color background
 * - --agent CLI flag: Returns "@agentName" with cyan background
 */
export function useAgentBanner(): AgentBannerInfo {
  const standaloneAgentContext = useAppState(s => s.standaloneAgentContext)
  const agent = useAppState(s => s.agent)
  // Subscribe so the banner updates on enter/exit agent view even though
  // getActiveAgentForInput reads it from store.getState().
  useAppState(s => s.viewingAgentTaskId)
  const state = useAppStateStore().getState()

  // Viewing a background agent (CoordinatorTaskPanel): reverse-lookup the
  // name from agentNameRegistry the same way CoordinatorAgentStatus does.
  const active = getActiveAgentForInput(state)
  if (active.type === 'named_agent') {
    const task = active.task
    let name: string | undefined
    for (const [n, id] of state.agentNameRegistry) {
      if (id === task.id) {
        name = n
        break
      }
    }
    return {
      text: name ? `@${name}` : task.description,
      bgColor: getAgentColor(task.agentType) ?? 'cyan_FOR_SUBAGENTS_ONLY',
    }
  }

  // Standalone agent (/rename, /color): name and/or custom color.
  const standaloneName = getStandaloneAgentName(state)
  const standaloneColor = standaloneAgentContext?.color
  if (standaloneName || standaloneColor) {
    return {
      text: standaloneName ?? '',
      bgColor: toThemeColor(standaloneColor),
    }
  }

  // --agent CLI flag.
  if (agent) {
    const agentDef = state.agentDefinitions.activeAgents.find(
      a => a.agentType === agent,
    )
    return {
      text: agent,
      bgColor: toThemeColor(agentDef?.color, 'promptBorder'),
    }
  }

  return null
}

function toThemeColor(
  colorName: string | undefined,
  fallback: keyof Theme = 'cyan_FOR_SUBAGENTS_ONLY',
): keyof Theme {
  return colorName && AGENT_COLORS.includes(colorName as AgentColorName)
    ? AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName]
    : fallback
}
