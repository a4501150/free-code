import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getMonitorManager } from '../../utils/monitors.js'
import { isBackgroundTasksEnabled } from '../../utils/backgroundTasks.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  MONITOR_LIST_DESCRIPTION,
  MONITOR_LIST_TOOL_NAME,
} from './constants.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema

interface MonitorSummary {
  monitor_id: string
  label: string
  command: string
  status: 'running' | 'stopped' | 'exited' | 'error'
  started_at: number
  ended_at?: number
  exit_code?: number
  recent_output: string[]
}

interface Output {
  count: number
  monitors: MonitorSummary[]
}

export const MonitorListTool = buildTool({
  name: MONITOR_LIST_TOOL_NAME,

  userFacingName: () => 'Monitor List',

  get inputSchema(): InputSchema {
    return inputSchema
  },

  outputSchema: z.object({
    count: z.number(),
    monitors: z.array(
      z.object({
        monitor_id: z.string(),
        label: z.string(),
        command: z.string(),
        status: z.string(),
        started_at: z.number(),
        ended_at: z.number().optional(),
        exit_code: z.number().optional(),
        recent_output: z.array(z.string()),
      }),
    ),
  }),

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  isEnabled() {
    return isBackgroundTasksEnabled()
  },

  async description() {
    return 'List all background monitors and their status'
  },

  async prompt() {
    return MONITOR_LIST_DESCRIPTION
  },

  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },

  renderToolUseMessage() {
    return 'Listing monitors...'
  },

  renderToolResultMessage(output: Output) {
    if (output.count === 0) return 'No monitors running.'
    const lines = output.monitors
      .map(
        m =>
          `  ${m.label} (${m.monitor_id}) — ${m.status}${m.exit_code !== undefined ? ` (exit ${m.exit_code})` : ''}\n    command: ${m.command}`,
      )
      .join('\n')
    return `Monitors (${output.count}):\n${lines}`
  },

  async call() {
    const monitors = getMonitorManager().list()

    const summaries: MonitorSummary[] = monitors
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1
        if (a.status !== 'running' && b.status === 'running') return 1
        return b.startedAt - a.startedAt
      })
      .map(m => ({
        monitor_id: m.id,
        label: m.label,
        command: m.command,
        status: m.status,
        started_at: m.startedAt,
        ...(m.endedAt !== undefined ? { ended_at: m.endedAt } : {}),
        ...(m.exitCode !== undefined ? { exit_code: m.exitCode } : {}),
        recent_output: m.output.slice(-5),
      }))

    return { data: { count: summaries.length, monitors: summaries } }
  },
} satisfies ToolDef<InputSchema, Output>)
