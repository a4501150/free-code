export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Use this tool to update a task in the task list.

## Lifecycle

- Mark \`completed\` only when the task is fully accomplished: tests passing, implementation complete, no unresolved errors. If blocked, keep it \`in_progress\` and create a new task describing what needs to be resolved.
- Setting status to \`deleted\` permanently removes a task that is no longer relevant or was created in error.
- Status progresses: \`pending\` → \`in_progress\` → \`completed\`.

Read a task's latest state with \`TaskGet\` before updating it.
`
