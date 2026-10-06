export const DESCRIPTION = 'Get a task by ID from the task list'

export const PROMPT = `Use this tool to retrieve a task by its ID: the full description, the dependencies (what it blocks, what blocks it), and the current state. Verify its blockedBy list is empty before beginning work; use TaskList to see all tasks in summary form. A subagent can also read the parent session's tasks this way; they are marked read-only and cannot be updated by the subagent.
`
