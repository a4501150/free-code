/**
 * The one nudge a just-backgrounded command carries. Single source: the
 * tool_result text the model receives and the TUI result line render the
 * same sentence verbatim — the user sees exactly what the model was told.
 */
export const BACKGROUND_TASK_NUDGE =
  'The command keeps running until it exits; you do not need to wait or poll — a system task notification reporting its status and output file will be delivered in a later turn.'
