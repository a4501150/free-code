import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getMainTaskListId,
  getTaskListId,
  isInSubagentContext,
  listTasks,
  TaskStatusSchema,
  type Task,
} from '../../utils/tasks.js'
import { TASK_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema

const outputSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      status: TaskStatusSchema,
      owner: z.string().optional(),
      blockedBy: z.array(z.string()),
      // Set on rows from the parent session's list shown to a subagent.
      fromParent: z.boolean().optional(),
    }),
  ),
})
type OutputSchema = typeof outputSchema

export type Output = z.infer<OutputSchema>

type TaskRow = Output['tasks'][number]

/**
 * Drop `_internal` tasks upstream; resolve blockedBy against the completed
 * tasks of the same list only. fromParent marks rows read from the parent
 * session's list (subagent view).
 */
function summarizeTasks(tasks: Task[], fromParent?: boolean): TaskRow[] {
  const resolvedTaskIds = new Set(
    tasks.filter(t => t.status === 'completed').map(t => t.id),
  )

  return tasks.map(task => ({
    id: task.id,
    subject: task.subject,
    status: task.status,
    owner: task.owner,
    blockedBy: task.blockedBy.filter(id => !resolvedTaskIds.has(id)),
    ...(fromParent ? { fromParent: true } : {}),
  }))
}

export const TaskListTool = buildTool({
  name: TASK_LIST_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema
  },
  userFacingName() {
    return 'TaskList'
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    const taskListId = getTaskListId()

    const allTasks = (await listTasks(taskListId)).filter(
      t => !t.metadata?._internal,
    )

    const tasks = summarizeTasks(allTasks)

    // Subagents see their own list plus a read-only view of the parent
    // session's list. blockedBy is resolved per list: task IDs are only
    // unique within one list.
    if (isInSubagentContext()) {
      const parentTasks = (await listTasks(getMainTaskListId())).filter(
        t => !t.metadata?._internal,
      )
      tasks.push(...summarizeTasks(parentTasks, true))
    }

    return {
      data: {
        tasks,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { tasks } = content as Output

    const renderRows = (rows: TaskRow[]) =>
      rows.map(task => {
        const owner = task.owner ? ` (${task.owner})` : ''
        const blocked =
          task.blockedBy.length > 0
            ? ` [blocked by ${task.blockedBy.map(id => `#${id}`).join(', ')}]`
            : ''
        return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`
      })

    const ownRows = tasks.filter(t => !t.fromParent)
    const parentRows = tasks.filter(t => t.fromParent)

    let text: string
    if (parentRows.length === 0) {
      // Single-list view (main session, or subagent with empty parent list).
      text =
        ownRows.length === 0 ? 'No tasks found' : renderRows(ownRows).join('\n')
    } else {
      const sections: string[] = []
      sections.push(
        ownRows.length > 0
          ? `Your task list:\n${renderRows(ownRows).join('\n')}`
          : 'Your task list is empty.',
      )
      sections.push(
        `Parent session's task list (read-only — you cannot update these tasks; use TaskGet to read one in full):\n${renderRows(parentRows).join('\n')}`,
      )
      text = sections.join('\n\n')
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: text,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
