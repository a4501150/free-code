export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Use this tool to update a task in the task list.

## Lifecycle

- Mark a task \`in_progress\` BEFORE you start it, and keep exactly one of your own tasks \`in_progress\` at a time.
- Mark a task \`completed\` as soon as you finish it. Do not batch up completions to do at the end.
- Mark \`completed\` only when the task is fully accomplished: tests passing, implementation complete, no unresolved errors. If blocked, keep it \`in_progress\` and create a new task describing what needs to be resolved.
- Setting status to \`deleted\` permanently removes a task that is no longer relevant or was created in error.
- Status progresses: \`pending\` → \`in_progress\` → \`completed\`.

Read a task's latest state with \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`
`
