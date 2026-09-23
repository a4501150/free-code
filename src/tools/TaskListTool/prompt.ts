import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

export const DESCRIPTION = 'List all tasks in the task list'

export function getPrompt(): string {
  const teammateUseCase = isAgentSwarmsEnabled()
    ? `Before assigning tasks to teammates, call it to see which tasks are available.
`
    : ''

  const teammateWorkflow = isAgentSwarmsEnabled()
    ? `
## Teammate Workflow

When working as a teammate:
1. After completing your current task, call TaskList to find available work
2. Look for tasks with status 'pending', no owner, and empty blockedBy
3. Claim an available task by marking it \`in_progress\` with TaskUpdate (you become its owner automatically)
4. If a task is blocked, work on the tasks that remove the block, or notify the team lead
`
    : ''

  return `Use this tool to list all tasks in the task list: what is available to work on (status: 'pending', no owner, not blocked), overall progress, and what is blocked and needs dependencies resolved. After completing a task, call it to check for newly unblocked work or claim the next task; prefer working on tasks in ID order (lowest ID first) when multiple are available, as earlier tasks often set up context for later ones.
${teammateUseCase}
Returns one row per task: id, subject, status, owner, and open blockedBy IDs (a task with open blockedBy cannot start until the tasks blocking it are completed).

Subagents work on their own isolated task list. When a subagent calls this tool, the parent session's list is appended as a separate read-only section: the subagent can read those tasks but TaskCreate and TaskUpdate only affect its own list.
${teammateWorkflow}`
}
