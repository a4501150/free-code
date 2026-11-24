/**
 * The one nudge a just-backgrounded command carries. Single source: the
 * tool_result text the model receives and the TUI result line render the
 * same sentence verbatim — the user sees exactly what the model was told.
 */
export const BACKGROUND_TASK_NUDGE =
  'The command keeps running until it exits. Do not run `sleep` or any other blocking wait-then-read next — none of it makes the notification arrive sooner; peeking at the output file (Read/grep/tail) is fine. A system task notification reporting its status and output file will be delivered in a later turn; if you have nothing else to do, end your turn. The output file is the COMPLETE unfiltered stream — you never need your own log copy — and it stays readable after completion, so you can Read or grep it repeatedly.'
