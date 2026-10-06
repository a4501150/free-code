export const MONITOR_TOOL_NAME = 'Monitor'
export const MONITOR_LIST_TOOL_NAME = 'MonitorList'
export const MONITOR_STOP_TOOL_NAME = 'MonitorStop'

export const MONITOR_DESCRIPTION = `Start a background monitor that watches something and surfaces output lines as they arrive, without pausing the conversation. Use it to: tail a log file and flag errors, poll a PR or CI job and report status changes, watch a directory for file changes, or track output from any long-running script. The command runs with the same permission rules as the Bash tool. The monitor keeps running in the background; you keep working and will be notified of new output at the start of your next turn, and only when it changed. Use MonitorList to check status and MonitorStop to cancel a monitor.

IMPORTANT:
- For polling scripts, only output a line when the status CHANGES — identical consecutive lines are suppressed and will not trigger a notification.
- Every notification costs a full agent turn (debounced to at most one per 5s), so never stream high-frequency output such as raw build progress (bazel, webpack, gradle): filter the stream or wrap the command so only status changes or errors reach the monitor.
- Never use this for commands you need the result of now — use the Bash tool directly. Monitors are for watching, not executing.`

export const MONITOR_LIST_DESCRIPTION = `
- Lists all background monitors and their current status
- Returns monitor ID, label, command, status, timing, and recent output lines
- Use this to check what monitors are running or recently exited
`

export const MONITOR_STOP_DESCRIPTION = `
- Stops a background monitor by its ID
- Returns the monitor's final output lines
- Use MonitorList to find the monitor ID
`
