import { z } from 'zod/v4'
import type { TaskStateBase } from '../../Task.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { TaskState } from '../../tasks/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { BACKGROUND_TASK_LIST_TOOL_NAME, DESCRIPTION } from './constants.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema

interface TaskSummary {
  task_id: string
  task_type: string
  status: string
  description: string
  start_time: number
  end_time?: number
  output_file: string
  command?: string
  exit_code?: number
  agent_type?: string
  model?: string
}

interface Output {
  count: number
  tasks: TaskSummary[]
}

function toSummary(task: TaskState): TaskSummary {
  const base: TaskSummary = {
    task_id: task.id,
    task_type: task.type,
    status: task.status,
    description: task.description,
    start_time: task.startTime,
    output_file: task.outputFile,
  }
  if (task.endTime) {
    base.end_time = task.endTime
  }
  if (task.type === 'local_bash') {
    base.command = (task as TaskStateBase & { command?: string }).command
    const result = (task as TaskStateBase & { result?: { code?: number } })
      .result
    if (result?.code !== undefined) {
      base.exit_code = result.code
    }
  }
  if (task.type === 'local_agent') {
    const agent = task as TaskStateBase & {
      agentType?: string
      model?: string
    }
    base.agent_type = agent.agentType
    base.model = agent.model
  }
  return base
}

export const BackgroundTaskListTool = buildTool({
  name: BACKGROUND_TASK_LIST_TOOL_NAME,
  userFacingName: () => 'List Background Tasks',
  get inputSchema(): InputSchema {
    return inputSchema
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return 'List all background tasks and their status'
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage() {
    return 'Listing background tasks...'
  },
  renderToolResultMessage(output: Output) {
    if (output.count === 0) {
      return 'No background tasks.'
    }
    return `${output.count} background task(s).`
  },
  async call(_input, { getAppState }) {
    const allTasks = Object.values(getAppState().tasks ?? {}) as TaskState[]

    const tasks = allTasks
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1
        if (a.status !== 'running' && b.status === 'running') return 1
        return b.startTime - a.startTime
      })
      .map(toSummary)

    return { data: { count: tasks.length, tasks } }
  },
} satisfies ToolDef<InputSchema, Output>)
