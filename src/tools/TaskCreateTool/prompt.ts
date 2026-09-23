import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

export const DESCRIPTION = 'Create a new task in the task list'

export function getPrompt(): string {
  const teammateContext = isAgentSwarmsEnabled()
    ? ' and potentially assigned to teammates'
    : ''

  const teammateTips = isAgentSwarmsEnabled()
    ? `- Include enough detail in the description for another agent to understand and complete the task
- New tasks are created with status 'pending' and no owner - a task becomes owned by whichever agent marks it \`in_progress\`
`
    : ''

  return `Use this tool to create tasks in the task list — it tracks progress for you and shows the user how the work is unfolding.

- Use it for complex multi-step work (3 or more distinct steps or operations${teammateContext}), in plan mode, when the user asks for a todo list or hands over multiple tasks, or when new instructions arrive that capture requirements as work items. Skip it for a single straightforward task or a conversational request — just do the work.
- Check TaskList first to avoid duplicates. Give each task a clear, specific subject that describes the outcome; after creating, use TaskUpdate to set dependencies (blocks/blockedBy) when needed.
- Once a list exists, keep it accurate — a list that lags behind the work is worse than no list. Mark a task \`in_progress\` BEFORE you start it, keep exactly one of your own tasks \`in_progress\` at a time, and mark it \`completed\` as soon as it is done; do not batch completions.
- Add follow-up tasks as you discover them, and delete tasks that are no longer relevant.
${teammateTips}`
}
