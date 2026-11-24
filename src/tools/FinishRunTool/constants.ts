export const FINISH_RUN_TOOL_NAME = 'FinishRun'

/**
 * The tool's name before the FinishRun rename. Persisted transcripts carry
 * `tool_use` blocks (and reminder texts) naming EndTurn, so every consumer
 * that recognizes completion calls or old nudges by name must accept both.
 */
export const LEGACY_END_TURN_TOOL_NAME = 'EndTurn'

/**
 * XML tag wrapping the harness's finish-run nudge (runAgent's reminder text
 * for a subagent that ended its turn without calling FinishRun). The tag is
 * what makes the nudge recognizable downstream: the UI renders it as a
 * visible reminder row (never as user input), and result extraction
 * identifies nudge replies by it. The VALUE predates the FinishRun rename
 * and is deliberately kept — it is a wire format persisted in transcripts,
 * and old sessions must keep rendering/extracting.
 */
export const FINISH_RUN_REMINDER_TAG = 'end-turn-reminder'

/**
 * The end-turn nudge the strict end_turn model delivered on a reminder
 * round — no longer sent (implicit completion replaced it: a text-only end
 * with nothing running completes the run), but kept verbatim for resumed
 * transcripts: the UI must keep rendering old nudge rows and
 * finalizeAgentTool's ack-skip matches them by exact text. "Already
 * delivered — do not restate" was load-bearing: an earlier wording told the
 * model its most recent text would become the result, which it read as
 * "resend the report", and the restatement then replaced the original
 * report as the subagent's delivered result (finalizeAgentTool picks the
 * last text).
 */
export const FINISH_RUN_REMINDER = `<${FINISH_RUN_REMINDER_TAG}>
You ended your turn without calling the ${FINISH_RUN_TOOL_NAME} tool, so your run is still active and your caller is still waiting.
Your last text message was already delivered to the caller — do not repeat or restate it.
If your work is complete, call ${FINISH_RUN_TOOL_NAME} now; no further text is needed.
Continue working only if something is still unfinished.
</${FINISH_RUN_REMINDER_TAG}>`

/**
 * The pre-rename FINISH_RUN_REMINDER, verbatim. `lastEndReminderIndex`
 * (agentToolUtils) identifies plain nudges by exact full text — a resumed
 * run is seeded from a transcript that may hold old-format nudges, so the
 * ack-skip logic must match either wording. Owned-tasks reminders share the
 * wrapper tag but neither exact text and must never match either.
 */
export const LEGACY_END_TURN_REMINDER = `<${FINISH_RUN_REMINDER_TAG}>
You ended your turn without calling the ${LEGACY_END_TURN_TOOL_NAME} tool, so your run is still active and your caller is still waiting.
Your last text message was already delivered to the caller — do not repeat or restate it.
If your work is complete, call ${LEGACY_END_TURN_TOOL_NAME} now; no further text is needed.
Continue working only if something is still unfinished.
</${FINISH_RUN_REMINDER_TAG}>`

/** Whether text is a nudge (or an owned-tasks reminder sharing the tag). */
export function isFinishRunReminderText(text: string): boolean {
  return text.startsWith(`<${FINISH_RUN_REMINDER_TAG}>`)
}

/** Body of a nudge message, or null if the text isn't one. */
export function extractFinishRunReminderBody(text: string): string | null {
  const open = `<${FINISH_RUN_REMINDER_TAG}>`
  const close = `</${FINISH_RUN_REMINDER_TAG}>`
  if (!text.startsWith(open) || !text.endsWith(close)) return null
  const body = text.slice(open.length, text.length - close.length).trim()
  return body || null
}

/**
 * Whether a content block is the FinishRun completion call (or its
 * pre-rename EndTurn spelling, which resumed transcripts still carry).
 * FinishRun is internal run protocol, not work: tool-use counts and
 * progress/expand displays must leave it out so it never reads as a real
 * tool call next to the agent's result (full transcript views still show it
 * deliberately for debugging). Dependency-free on purpose — shared by the
 * React-free task tracker and the UI.
 */
export function isFinishRunToolUse(block: {
  type: string
  name?: string
}): boolean {
  return (
    block.type === 'tool_use' &&
    (block.name === FINISH_RUN_TOOL_NAME ||
      block.name === LEGACY_END_TURN_TOOL_NAME)
  )
}

/**
 * Whether a content block is real work: a tool call that is not the
 * FinishRun completion protocol (which is internal run mechanics, not
 * tooling). Shared by tool-use counting, work detection and the
 * round-work tracking in runAgent.
 */
export function isRealToolUse(block: { type: string; name?: string }): boolean {
  return block.type === 'tool_use' && !isFinishRunToolUse(block)
}

export const DESCRIPTION = `Ends your run immediately, killing every background task you still own (backgrounded bash, monitors).
You do NOT need this tool to finish your run: ending your message with a final report and no tool calls completes the run, and that text is delivered to the caller as your result.
Use this tool only to abandon owned background tasks. With owned tasks running, a first call is gated with a reminder; a second consecutive call ends the run and abandons them. To wait for a running task instead, end your message with no tool calls at all — your run parks, and the task's completion notification is delivered to you.`
