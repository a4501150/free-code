import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { getAgentModelDisplay as getAgentModelDisplayName } from '../../utils/model/agent.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isTeammate } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { isWorktreeModeEnabled } from '../../utils/worktreeModeEnabled.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../TaskListTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkAgentEnabled } from './built-in/forkAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // Both defined: filter allowlist by denylist to match runtime behavior
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // Allowlist only: show the specific tools available
    return tools.join(', ')
  } else if (hasDenylist) {
    // Denylist only: show "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // No restrictions
  return 'All tools'
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
function getModelDisplayForPrompt(model: string | undefined): string {
  if (!model) return ''
  try {
    const display = getAgentModelDisplayName(model)
    if (
      display === 'Inherit from parent (default)' ||
      display === 'Inherit from parent'
    )
      return ''
    return ` (Default model: ${display})`
  } catch {
    return ` (Default model: ${model})`
  }
}

export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  const modelDisplay = getModelDisplayForPrompt(agent.model)
  return `- ${agent.agentType}: ${agent.whenToUse}${modelDisplay} (Tools: ${toolsDescription})`
}

/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getInitialSettings()?.agentListInMessages ?? true
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  const forkAvailable =
    isForkAgentEnabled() && effectiveAgents.some(a => a.agentType === 'fork')

  // When the gate is on, the agent list lives in an agent_listing_delta
  // attachment (see attachments.ts) instead of inline here. This keeps the
  // tool description static across MCP/plugin/permission changes so the
  // tools-block prompt cache doesn't bust every time an agent loads.
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = `Launch a specialized agent (subprocess) to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

${agentListSection}

When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
  if (isCoordinator) {
    return shared
  }

  const whenNotToUse = `Do not use ${AGENT_TOOL_NAME} for tasks you can handle directly (reading specific files, targeted searches) or for tasks unrelated to the listed agent descriptions.`

  const whenToForkSection = forkAvailable
    ? `

## When to fork
Fork yourself (pass \`subagent_type: "fork"\`) when the intermediate tool output is not worth keeping in your context — a fork inherits your transcript and shares your prompt cache. Open-ended questions and independent research questions are good fork tasks. Launch parallel forks in one message.
- Write the fork prompt as a directive (what to do), not a briefing — it already has your context. State what is in scope and what is out.
- Do not Read or tail the \`output_file\` while the fork runs. That brings the fork's tool output into your context and defeats the purpose.
- After you launch a fork, you know nothing about what it found. Never fabricate or predict its result. Until the completion notification arrives, report "still running", not a guess.`
    : ''

  const promptingSection = `

## Prompting
${forkAvailable ? 'Any agent other than a fork starts with zero context. ' : ''}Brief the agent like a colleague who just entered the room — it has not seen this conversation. Explain the goal, what you already ruled out, and enough surrounding context for it to make judgment calls. Never delegate understanding: "based on your findings, fix the bug" pushes the reasoning onto the agent. Write a prompt that shows you understood the task — name file paths and what specifically to change — and say clearly whether to write code or only research.`

  // When listing via attachment, the parallel-launch note is in the
  // attachment message. When inline, include it here.
  const concurrencyNote = !listViaAttachment
    ? `; to run agents in parallel, use a single message with multiple tool uses`
    : ''

  // Non-coordinator gets the lean worker contract: handoff facts, no examples.
  return `${shared}
${whenNotToUse}${whenToForkSection}

- The agent returns a single message back to you and the result is not visible to the user, so send a concise summary yourself. Agents are not suitable for retrieving full file contents — file data read by the agent is summarized or lost in the single-message handoff; use the Read tool directly for full content${concurrencyNote}.
- The agent works on its own task list and cannot change yours: ${TASK_LIST_TOOL_NAME} inside the agent shows your list as read-only context. Put everything the agent must act on in the prompt, not in a task description it has to look up.
- Avoid duplicating work that active agents are already doing. If you delegate research, do not perform the same searches yourself.${
    isAgentSwarmsEnabled()
      ? `
- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field; it resumes with its full context. Each Agent invocation starts fresh — provide a complete task description.`
      : ''
  }${
    isWorktreeModeEnabled()
      ? `
- Set \`isolation: "worktree"\` to run the agent in a temporary git worktree — an isolated copy of the repository. It is cleaned up automatically if the agent makes no changes; otherwise the worktree path and branch are returned in the result.`
      : ''
  }${
    isInProcessTeammate()
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${promptingSection}`
}
