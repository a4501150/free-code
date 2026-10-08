export const DESCRIPTION = 'List all tasks in the task list'

export function getPrompt(): string {
  return `Use this tool to list all tasks in the task list: what is available to work on (status: 'pending', no owner, not blocked), overall progress, and what is blocked. After completing a task, call it to check for newly unblocked work or pick up the next task; prefer tasks in ID order (lowest ID first), as earlier tasks often set up context for later ones.
Returns one row per task; open blockedBy IDs mean the task cannot start until those tasks are completed.

Subagents work on their own isolated task list. When a subagent calls this tool, the parent session's list is appended as a separate read-only section: the subagent can read those tasks but TaskCreate and TaskUpdate only affect its own list.
`
}
