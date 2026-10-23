/**
 * The one nudge a just-backgrounded command carries. Single source: the
 * tool_result text the model receives and the TUI result line render the
 * same sentence verbatim — the user sees exactly what the model was told.
 */
export const BACKGROUND_TASK_NUDGE =
  'The command keeps running until it exits. Do not run `sleep`, `tail`, or any other wait-then-read next — none of it makes the notification arrive sooner. A system task notification reporting its status and output file will be delivered in a later turn; if you have nothing else to do, end your turn.'
