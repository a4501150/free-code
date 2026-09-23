export const DESCRIPTION = 'Get a task by ID from the task list'

export const PROMPT = `Use this tool to retrieve a task by its ID: the full description and context before starting work, the dependencies (what it blocks, what blocks it), and the current state. Verify its blockedBy list is empty before beginning work; use TaskList to see all tasks in summary form. A subagent also reads the parent session's task list when the ID is not in its own list; such tasks are marked read-only and cannot be updated by the subagent.
`
