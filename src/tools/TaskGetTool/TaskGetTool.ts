import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getMainTaskListId,
  getTask,
  getTaskListId,
  isInSubagentContext,
  TaskStatusSchema,
} from '../../utils/tasks.js'
import { TASK_GET_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = z.strictObject({
  taskId: z.string().describe('The ID of the task to retrieve'),
})
type InputSchema = typeof inputSchema

const outputSchema = z.object({
  task: z
    .object({
      id: z.string(),
      subject: z.string(),
      description: z.string(),
      status: TaskStatusSchema,
      blocks: z.array(z.string()),
      blockedBy: z.array(z.string()),
      // Set when a subagent read the task from the parent session's list.
      fromParent: z.boolean().optional(),
    })
    .nullable(),
})
type OutputSchema = typeof outputSchema

export type Output = z.infer<OutputSchema>

export const TaskGetTool = buildTool({
  name: TASK_GET_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema
  },
  userFacingName() {
    return 'TaskGet'
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
  toAutoClassifierInput(input) {
    return input.taskId
  },
  renderToolUseMessage() {
    return null
  },
  async call({ taskId }) {
    const taskListId = getTaskListId()

    let task = await getTask(taskListId, taskId)
    let fromParent = false

    // Subagents also read the parent session's list (read-only fallback):
    // TaskList shows those rows, and TaskGet must be able to open them.
    if (!task && isInSubagentContext()) {
      task = await getTask(getMainTaskListId(), taskId)
      fromParent = task !== null
    }

    if (!task) {
      return {
        data: {
          task: null,
        },
      }
    }

    return {
      data: {
        task: {
          id: task.id,
          subject: task.subject,
          description: task.description,
          status: task.status,
          blocks: task.blocks,
          blockedBy: task.blockedBy,
          ...(fromParent ? { fromParent: true } : {}),
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    if (!task) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'Task not found',
      }
    }

    const lines = [
      `Task #${task.id}: ${task.subject}${
        task.fromParent ? " (from the parent session's list — read-only)" : ''
      }`,
      `Status: ${task.status}`,
      `Description: ${task.description}`,
    ]

    if (task.blockedBy.length > 0) {
      lines.push(`Blocked by: ${task.blockedBy.map(id => `#${id}`).join(', ')}`)
    }
    if (task.blocks.length > 0) {
      lines.push(`Blocks: ${task.blocks.map(id => `#${id}`).join(', ')}`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
