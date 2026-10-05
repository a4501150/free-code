import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getMonitorManager } from '../../utils/monitors.js'
import { isBackgroundTasksEnabled } from '../../utils/backgroundTasks.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  MONITOR_STOP_DESCRIPTION,
  MONITOR_STOP_TOOL_NAME,
} from './constants.js'

const inputSchema = z.strictObject({
  monitor_id: z
    .string()
    .describe(
      'The ID of the monitor to stop, as returned by the Monitor tool.',
    ),
})
type InputSchema = typeof inputSchema

interface Output {
  stopped: boolean
  monitor_id: string
  label: string
  status: 'running' | 'stopped' | 'exited' | 'error'
  final_output: string[]
}

export const MonitorStopTool = buildTool({
  name: MONITOR_STOP_TOOL_NAME,

  userFacingName: () => 'Monitor Stop',

  get inputSchema(): InputSchema {
    return inputSchema
  },

  outputSchema: z.object({
    stopped: z.boolean(),
    monitor_id: z.string(),
    label: z.string(),
    status: z.string(),
    final_output: z.array(z.string()),
  }),

  isReadOnly() {
    return false
  },

  isConcurrencySafe() {
    return false
  },

  isEnabled() {
    return isBackgroundTasksEnabled()
  },

  async description({ monitor_id }) {
    return `Stop monitor: ${monitor_id ?? ''}`.trim()
  },

  async prompt() {
    return MONITOR_STOP_DESCRIPTION
  },

  toAutoClassifierInput(input) {
    return input.monitor_id
  },

  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },

  renderToolUseMessage(input) {
    return `Stopping monitor: ${input.monitor_id ?? ''}`
  },

  renderToolResultMessage(output: Output) {
    const lines = output.final_output.slice(-20).join('\n')
    const tail = lines ? `\nFinal output:\n${lines}` : ''
    return `Monitor "${output.label}" ${output.stopped ? 'stopped' : `not stopped (status: ${output.status})`}.${tail}`
  },

  async call(input) {
    const manager = getMonitorManager()
    const monitor = manager.get(input.monitor_id)

    if (!monitor) {
      return {
        data: {
          stopped: false,
          monitor_id: input.monitor_id,
          label: '',
          status: 'exited' as const,
          final_output: [`No monitor with id "${input.monitor_id}".`],
        },
      }
    }

    const wasRunning = monitor.status === 'running'
    const stopped = manager.stop(input.monitor_id)
    const finalOutput = [...monitor.newOutput]

    if (!stopped && !wasRunning) {
      return {
        data: {
          stopped: false,
          monitor_id: monitor.id,
          label: monitor.label,
          status: monitor.status,
          final_output:
            finalOutput.length > 0 ? finalOutput : ['Monitor is not running.'],
        },
      }
    }

    return {
      data: {
        stopped: true,
        monitor_id: monitor.id,
        label: monitor.label,
        status: monitor.status,
        final_output:
          finalOutput.length > 0
            ? finalOutput
            : ['Monitor stopped with no further output.'],
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
