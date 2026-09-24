import { isBackgroundTasksEnabled } from '../../utils/backgroundTasks.js'
import { getAgentModelDisplay as getAgentModelDisplayName } from '../../utils/model/agent.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isTeammate } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
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
 */
export function shouldInjectAgentListInMessages(): boolean {
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
  const shared = `Launches a specialized agent (subagent) to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

${agentListSection}

Specify the ${AGENT_TOOL_NAME} tool's subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
  if (isCoordinator) {
    return shared
  }

  const whenNotToUse = `Do not use ${AGENT_TOOL_NAME} for tasks you can handle directly (reading specific files, targeted searches) or for tasks unrelated to the listed agent descriptions.`

  // Shares the backgroundTasksEnabled gate with the run_in_background param
  // (stripped from the schema in AgentTool.tsx when the setting is off), so
  // the prompt and schema never disagree about what exists.
  const backgroundSection = isBackgroundTasksEnabled()
    ? `

When running an agent in the foreground, the tool blocks and returns the agent's final report as this call's tool result.
When running an agent in the background (\`run_in_background: true\`), the tool returns immediately with the agent's ID; when the agent finishes, its report is delivered as a system task notification. You don't have to do anything while waiting for a backgrounded agent: once it completes, the notification is delivered automatically by the harness. Backgrounding is not a parallelism mechanism — to run agents in parallel whose results you need together, send multiple ${AGENT_TOOL_NAME} tool uses in a single message.`
    : ''

  const whenToForkSection = forkAvailable
    ? `

## When to fork
Fork yourself (pass \`subagent_type: "fork"\`) when the intermediate tool output is not worth keeping in your context — a fork inherits your transcript and shares your prompt cache. Open-ended questions and independent research questions are good fork tasks. By default a fork's report is this call's tool result; with \`run_in_background: true\` it reports later via the completion notification. Launch parallel forks in one message.
- Write the fork prompt as a directive (what to do), not a briefing — it already has your context. State what is in scope and what is out.
- While a backgrounded fork runs, do not Read or tail its output file — that brings the fork's tool output back into your context and defeats the purpose.
- Until the completion notification arrives, you know nothing about what the fork found. Report "still running", never a guess.`
    : ''

  const promptingSection = `

## Prompting
${forkAvailable ? 'Any agent other than a fork starts with zero context. ' : ''}Brief the agent like a colleague who just entered the room — it has not seen this conversation. Explain the goal, what you already ruled out, and enough surrounding context for it to make judgment calls. Never delegate understanding: "based on your findings, fix the bug" pushes the reasoning onto the agent. Name file paths and what specifically to change, and say clearly whether to write code or only research.`

  // Non-coordinator gets the lean worker contract: handoff facts, no examples.
  // The isolation and cwd facts live on their schema descriptions, which are
  // always in the schema, so they need no bullet here.
  return `${shared}

${whenNotToUse}${backgroundSection}${whenToForkSection}

- The agent returns a single message; the user sees it only by expanding the agent's result, so send a concise summary yourself. Do not use an agent to retrieve full file contents — what it reads is summarized in the handoff; use the Read tool directly.
- The agent works on its own task list and cannot change yours. Put everything the agent must act on in the prompt, not in a task description it has to look up.
- Avoid duplicating work that active agents are already doing. If you delegate research, do not run the same searches yourself.${
    isInProcessTeammate()
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${promptingSection}`
}
