import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { stopTask } from '../../tasks/stopTask.js'
import { mayStopTask, taskCoordinationAgentId } from '../../tasks/ownership.js'
import type { TaskState } from '../../tasks/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, BACKGROUND_TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = z.strictObject({
  task_id: z.string().optional(),
  // shell_id is accepted for backward compatibility with the deprecated KillShell tool
  shell_id: z.string().optional().describe('Deprecated: use task_id instead'),
})
type InputSchema = typeof inputSchema

const modelInputSchema = z.strictObject({
  task_id: z.string().describe('The ID of the background task to stop'),
})

const outputSchema = z.object({
  message: z.string().describe('Status message about the operation'),
  task_id: z.string().describe('The ID of the task that was stopped'),
  task_type: z.string().describe('The type of the task that was stopped'),
  // Optional: tool outputs are persisted to transcripts and replayed on --resume
  // without re-validation, so sessions from before this field was added lack it.
  command: z
    .string()
    .optional()
    .describe('The command or description of the stopped task'),
})
type OutputSchema = typeof outputSchema

export type Output = z.infer<OutputSchema>

export const BackgroundTaskStopTool = buildTool({
  name: BACKGROUND_TASK_STOP_TOOL_NAME,
  // Deprecated aliases kept for backward compatibility with existing
  // transcripts and SDK users.
  aliases: ['TaskStop', 'KillShell'],
  maxResultSizeChars: 100_000,
  userFacingName: () => 'Stop Background Task',
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get modelInputSchema() {
    return modelInputSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task_id ?? input.shell_id ?? ''
  },
  async validateInput({ task_id, shell_id }, context) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      return {
        result: false,
        message: 'Missing required parameter: task_id',
        errorCode: 1,
      }
    }

    const appState = context.getAppState()
    const task = appState.tasks?.[id] as TaskState | undefined

    if (!task) {
      return {
        result: false,
        message: `No task found with ID: ${id}`,
        errorCode: 1,
      }
    }

    if (task.status !== 'running') {
      return {
        result: false,
        message: `Task ${id} is not running (status: ${task.status})`,
        errorCode: 3,
      }
    }

    // Ownership: the main thread may stop anything; a subagent only the
    // shell/monitor tasks it spawned or the agents it spawned.
    if (!mayStopTask(task, context.agentId)) {
      const ownerAgentId = taskCoordinationAgentId(task)
      const ownerName = ownerAgentId
        ? [...(appState.agentNameRegistry ?? [])].find(
            ([, agentId]) => agentId === ownerAgentId,
          )?.[0]
        : undefined
      const ownerLabel = ownerAgentId
        ? `agent ${ownerName ? `${ownerName} (${ownerAgentId})` : ownerAgentId}`
        : 'the main session'
      const coordination = ownerAgentId
        ? ` Coordinate via SendMessage to: "${ownerAgentId}".`
        : ''
      return {
        result: false,
        message: `Task ${id} belongs to ${ownerLabel} — you can only stop tasks you own or agents you spawned.${coordination}`,
        errorCode: 4,
      }
    }

    return { result: true }
  },
  async description() {
    return `Stop a running background task by ID`
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(
    { task_id, shell_id },
    { getAppState, setAppState, setAppStateForTasks, abortController },
  ) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      throw new Error('Missing required parameter: task_id')
    }

    // Route through the always-shared task channel (same pattern as
    // BashTool): an async agent's setAppState is a no-op, so a plain
    // setAppState would silently drop the kill for the registry.
    const result = await stopTask(id, {
      getAppState,
      setAppState: setAppStateForTasks ?? setAppState,
    })

    return {
      data: {
        message: `Successfully stopped task: ${result.taskId} (${result.command})`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
