export const END_TURN_TOOL_NAME = 'EndTurn'

/**
 * XML tag wrapping the harness's end-turn nudge (runAgent's reminder text
 * for a subagent that ended its turn without calling EndTurn). The tag is
 * what makes the nudge recognizable downstream: the UI renders it as a
 * visible reminder row (never as user input), and result extraction
 * identifies nudge replies by it.
 */
export const END_TURN_REMINDER_TAG = 'end-turn-reminder'

/**
 * The nudge runAgent delivers on a reminder round. "Already delivered — do
 * not restate" is load-bearing: an earlier wording told the model its most
 * recent text would become the result, which it read as "resend the report",
 * and the restatement then replaced the original report as the subagent's
 * delivered result (finalizeAgentTool picks the last text). Wrapped in the
 * tag above so every consumer can recognize it without string-matching the
 * body.
 */
export const END_TURN_REMINDER = `<${END_TURN_REMINDER_TAG}>
You ended your turn without calling the ${END_TURN_TOOL_NAME} tool, so your run is still active and your caller is still waiting.
Your last text message was already delivered to the caller — do not repeat or restate it.
If your work is complete, call ${END_TURN_TOOL_NAME} now; no further text is needed.
Continue working only if something is still unfinished.
</${END_TURN_REMINDER_TAG}>`

/** Whether text is a nudge (or an owned-tasks reminder sharing the tag). */
export function isEndTurnReminderText(text: string): boolean {
  return text.startsWith(`<${END_TURN_REMINDER_TAG}>`)
}

/** Body of a nudge message, or null if the text isn't one. */
export function extractEndTurnReminderBody(text: string): string | null {
  const open = `<${END_TURN_REMINDER_TAG}>`
  const close = `</${END_TURN_REMINDER_TAG}>`
  if (!text.startsWith(open) || !text.endsWith(close)) return null
  const body = text.slice(open.length, text.length - close.length).trim()
  return body || null
}

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
