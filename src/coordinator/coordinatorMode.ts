import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { AGENT_REPORT_CONTRACT } from './agentReportContract.js'
import {
  isCoordinatorMode,
  isCoordinatorModeForcedByCli,
  setCoordinatorModeOverride,
} from './coordinatorModeGate.js'

export { isCoordinatorMode }

/**
 * Checks if the current coordinator mode matches the session's stored mode.
 * If mismatched, sets the in-process override so isCoordinatorMode() returns
 * the correct value for the resumed session. Returns a warning message if
 * the mode was switched, or undefined if no switch was needed.
 */
export function matchSessionMode(
  sessionMode: 'coordinator' | 'normal' | undefined,
): string | undefined {
  // No stored mode (old session before mode tracking) — do nothing
  if (!sessionMode) {
    return undefined
  }

  const currentIsCoordinator = isCoordinatorMode()
  const sessionIsCoordinator = sessionMode === 'coordinator'

  if (currentIsCoordinator === sessionIsCoordinator) {
    return undefined
  }

  // An explicit CLI --coordinator outranks the resumed session's stored
  // mode — the flag states what this process should be now (the assistant
  // gateway child resumes into a pre-coordinator session this way).
  if (currentIsCoordinator && isCoordinatorModeForcedByCli()) {
    return undefined
  }

  // Set the in-process override — isCoordinatorMode() reads it live, no caching
  setCoordinatorModeOverride(sessionIsCoordinator)

  return sessionIsCoordinator
    ? 'Entered coordinator mode to match resumed session.'
    : 'Exited coordinator mode to match resumed session.'
}

/**
 * The delegation-guidance block carried by the `coordinator_mode` attachment
 * (see src/utils/attachments.ts). Coordinator mode is normal mode plus this
 * block: same system prompt, same tool pool, same agent registry — the
 * attachment only directs the model to delegate via subagents. Rendered at
 * creation time and replayed byte-identically; re-announces wholesale when
 * the text changes (mirrors the assistant_mode carrier).
 */
export function buildCoordinatorModeBlock(options: {
  mcpServerNames: string[]
  scratchpadDir?: string
}): string {
  const parts = [
    '# Coordinator Mode',
    `You are running as a coordinator: delegate substantive work — research, implementation, verification — to subagents via the ${AGENT_TOOL_NAME} tool rather than doing everything yourself. Answer simple questions directly; do not delegate work that needs no tools.`,
    `- Subagents run in the background. Launch independent agents with multiple tool calls in one message so they run in parallel. Tell the user briefly what you launched, then end your turn.`,
    `- ${AGENT_REPORT_CONTRACT}`,
    `- Subagents cannot see this conversation. Every prompt must be self-contained: file paths, line numbers, error text, and what completion means. Synthesize findings into a concrete spec yourself — never write "based on your findings".`,
    `- Continue a finished subagent with SendMessage (its context is loaded); stop a wrongly-directed one with BackgroundTaskStop.`,
    `- Subagents have access to standard tools, MCP tools from connected MCP servers, and project skills via the Skill tool. Delegate only listed skill invocations to subagents; do not infer skill names from common workflows or built-in CLI commands.`,
  ]
  if (options.mcpServerNames.length > 0) {
    parts.push(
      `Connected MCP servers: ${options.mcpServerNames.join(', ')} — subagents can call their tools directly; you can reach them too via your own tools or RunCode.`,
    )
  }
  if (options.scratchpadDir) {
    parts.push(
      `Scratchpad directory: ${options.scratchpadDir} — subagents can read and write here without permission prompts. Use it for durable cross-worker knowledge — structure files however fits the work.`,
    )
  }
  return parts.join('\n\n')
}
