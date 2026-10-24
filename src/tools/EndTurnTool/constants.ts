export const END_TURN_TOOL_NAME = 'EndTurn'

/**
 * Whether a content block is the EndTurn completion call. EndTurn is
 * internal run protocol, not work: tool-use counts and progress/expand
 * displays must leave it out so it never reads as a real tool call next
 * to the agent's result (full transcript views still show it deliberately
 * for debugging). Dependency-free on purpose — shared by the React-free
 * task tracker and the UI.
 */
export function isEndTurnToolUse(block: {
  type: string
  name?: string
}): boolean {
  return block.type === 'tool_use' && block.name === END_TURN_TOOL_NAME
}

export const DESCRIPTION = `Signals that your work is complete and ends your run.
Your most recent text message is delivered to the caller as your final result, so write your report BEFORE or TOGETHER WITH this call — the tool takes no content.
Any background tasks you still own (backgrounded bash, monitors) are killed when you call this, so stop anything that must keep running, or keep waiting for it instead.
This is the ONLY way to finish your run: ending your message without tool calls does not end it — you will be asked again to either continue working or call this tool.`
