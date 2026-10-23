export const BACKGROUND_TASK_LIST_TOOL_NAME = 'BackgroundTaskList'

export const DESCRIPTION = `Lists background tasks and their current status — task ID, type, status, description, timing, and output file path, plus the owning agent of each.
A subagent sees full detail for the tasks it owns or spawned, and read-only hints on other agents' running tasks (with the owner's SendMessage address, for coordinating conflicts). The main session sees everything.
This list does not fetch output: an agent's report arrives in its completion notification; a background shell's output file is safe to Read.`
