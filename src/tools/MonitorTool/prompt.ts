import { BACKGROUND_TASK_STOP_TOOL_NAME } from '../BackgroundTaskStopTool/prompt.js'
import { BACKGROUND_TASK_LIST_TOOL_NAME } from '../BackgroundTaskListTool/constants.js'
import { NOTIFY_INTERVAL_FORMATS } from '../../utils/parseNotifyInterval.js'

export function getMonitorPrompt(): string {
  return [
    'Starts an open-ended watch: the command runs detached and keeps running; new output is surfaced as a system task notification at a turn boundary, not streamed mid-turn. Use it to react to output while it is still arriving — tailing a log, polling a CI job, waiting for a file to change. For a one-shot command whose result you need, use Bash (foreground or `run_in_background`) instead.',
    `The \`notify_interval\` parameter (${NOTIFY_INTERVAL_FORMATS}) is the MAXIMUM notification cadence, not a timer: a notification fires only when the latest output line differs from the last notified line, at most once per interval; a monitor exit or error always notifies immediately. Never emulate the cadence inside the command with \`sleep\` — run the first check immediately at t=0 and print only when the answer changes.`,
    'At t=0, verify you locked onto the right target: if it is missing, already terminal, or a different entity than you meant, print that finding and exit immediately instead of watching silently. An exit that prints nothing is a failed monitor — every exit path must print exactly one short line stating the outcome, and a failure inside the watch is an exit path too: start the script with `set -eu` or guard each setup step with `|| { echo "monitor error: <step>"; exit 1; }`.',
    "Every notification costs a full agent turn: wrap the command so it prints only answers and errors, and never redirect its output to your own file (`> out.log 2>&1`) — redirected output never reaches the watcher or the user. Set your own hard deadline — the harness never stops a monitor. When a notification arrives, quote its answer line in your reply. Check process liveness by PID (`kill -0 $pid`) or service state, never with `pgrep -f` on text that also appears in the monitor's own command line; capture `rc=$?` before any pipe.",
    `Check status on demand with ${BACKGROUND_TASK_LIST_TOOL_NAME} or by reading the output file; stop the monitor with ${BACKGROUND_TASK_STOP_TOOL_NAME}.`,
  ].join('\n')
}
