import { TASK_OUTPUT_TOOL_NAME } from '../TaskOutputTool/constants.js'

export const BACKGROUND_TASK_LIST_TOOL_NAME = 'BackgroundTaskList'

// The name reference is interpolated: the TaskOutput → BackgroundTaskOutput
// rename went stale in this string once.
export const DESCRIPTION = `
- Lists all background tasks and their current status
- Returns task ID, type, status, description, timing, and output file path
- Use this to check what background tasks are running or recently completed
- For full task output, use ${TASK_OUTPUT_TOOL_NAME} with the task ID
`
