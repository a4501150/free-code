export const BACKGROUND_TASK_LIST_TOOL_NAME = 'BackgroundTaskList'

export const DESCRIPTION = `
- Lists all background tasks and their current status
- Returns task ID, type, status, description, timing, and output file path
- Use this to check what background tasks are running or recently completed
- This list does not fetch output: an agent's report arrives in its completion notification; a background shell's full output can be Read from its output file
`
