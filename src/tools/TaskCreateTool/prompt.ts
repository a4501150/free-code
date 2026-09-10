import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

export const DESCRIPTION = 'Create a new task in the task list'

export function getPrompt(): string {
  const teammateContext = isAgentSwarmsEnabled()
    ? ' and potentially assigned to teammates'
    : ''

  const teammateTips = isAgentSwarmsEnabled()
    ? `- Include enough detail in the description for another agent to understand and complete the task
- New tasks are created with status 'pending' and no owner - use TaskUpdate with the \`owner\` parameter to assign them
`
    : ''

  return `Use this tool to create a structured task list for your current coding session. It tracks progress for you and shows the user how the work is unfolding.

## Lifecycle

Once a list exists, keep it accurate as you work — a list that lags behind the work is worse than no list:

- Mark a task \`in_progress\` BEFORE you start it, and keep exactly one of your own tasks \`in_progress\` at a time.
- Mark a task \`completed\` as soon as you finish it. Do not save the completion reports for the end.
- Add follow-up tasks as you discover them, and delete tasks that are no longer relevant.

## When to Use This Tool

- Complex multi-step tasks: 3 or more distinct steps or operations${teammateContext}
- Plan mode: create a task list to track the work
- The user explicitly requests a todo list, or provides multiple tasks to do
- New instructions arrive: capture the requirements as tasks immediately

## When NOT to Use This Tool

Skip it for a single straightforward task, or for purely conversational or informational requests - do the work directly.

All tasks are created with status \`pending\` and no owner.
${teammateTips}- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
`
}
