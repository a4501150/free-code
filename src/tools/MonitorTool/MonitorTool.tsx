import { z } from 'zod/v4'
import { bashToolHasPermission } from '../BashTool/bashPermissions.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getMonitorManager } from '../../utils/monitors.js'
import { isBackgroundTasksEnabled } from '../../utils/backgroundTasks.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { MONITOR_DESCRIPTION, MONITOR_TOOL_NAME } from './constants.js'
import { MonitorPermissionRequest } from './MonitorPermissionRequest.js'
import { wireMonitorNotifications } from './monitorNotifications.js'
import { registerMonitorTaskState } from './monitorTaskState.js'

const inputSchema = z.strictObject({
  command: z
    .string()
    .describe(
      'The shell command to run in the background; its stdout/stderr lines are captured as they arrive. Examples: `tail -f /var/log/app.log`, a polling script that checks a CI status. Never tail raw build/compile output — it floods the conversation with agent turns; wrap it so it prints only on completion, failure, or error.',
    ),
  label: z
    .string()
    .describe(
      "A short human-readable label for this monitor, e.g. 'app-log-tail' or 'ci-poll'.",
    ),
})
type InputSchema = typeof inputSchema

interface Output {
  monitor_id: string
  label: string
  status: 'running' | 'stopped' | 'exited' | 'error'
  summary: string
  initial_output: string[]
}

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,

  userFacingName: () => 'Monitor',

  get inputSchema(): InputSchema {
    return inputSchema
  },

  outputSchema: z.object({
    monitor_id: z.string(),
    label: z.string(),
    status: z.string(),
    summary: z.string(),
    initial_output: z.array(z.string()),
  }),

  isReadOnly() {
    return false
  },

  isConcurrencySafe() {
    return false
  },

  // Monitors are background processes, like the Bash tool's
  // run_in_background: disabled when the backgroundTasksEnabled setting
  // is off.
  isEnabled() {
    return isBackgroundTasksEnabled()
  },

  async description({ label, command }) {
    return `Start background monitor ${label ?? command ?? ''}`.trim()
  },

  async prompt() {
    return MONITOR_DESCRIPTION
  },

  toAutoClassifierInput(input) {
    return input.command
  },

  // Shell-command permission UX: the Bash dialog (per-prefix "don't ask
  // again" grants, compound breakdown) with the input narrowed to the
  // command — see MonitorPermissionRequest.tsx for why the saved rules are
  // Bash(prefix) rules (the only shape that matches future Monitor calls).
  renderPermissionRequest: () => MonitorPermissionRequest,

  // Monitor commands run shell commands, so they go through the exact Bash
  // permission pipeline (AST security parse, redirect checks, permission
  // rules). bashToolHasPermission only reads input.command.
  async checkPermissions(
    input: z.infer<InputSchema>,
    context: ToolUseContext,
  ): Promise<PermissionResult> {
    return bashToolHasPermission({ command: input.command }, context)
  },

  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: jsonStringify(output),
    }
  },

  renderToolUseMessage(input) {
    const label = input.label ?? input.command ?? ''
    return `Starting monitor: ${label}`
  },

  renderToolResultMessage(output: Output) {
    const lines = output.initial_output.slice(-10).join('\n')
    const tail = lines ? `\n${lines}` : ''
    return `${output.summary}\nMonitor "${output.label}" (id: ${output.monitor_id}) — status: ${output.status}${tail}`
  },

  async call(input, context) {
    const manager = getMonitorManager()
    const setAppState = context.setAppStateForTasks ?? context.setAppState
    wireMonitorNotifications(manager, setAppState)

    const monitor = manager.start(input.command, input.label, context.agentId)
    registerMonitorTaskState(monitor, setAppState, context.toolUseId)

    // Give the process a brief moment to produce initial output (e.g. an
    // immediate error from a bad command), but don't block the turn. Race
    // a short timeout against the first output line or early exit.
    await new Promise<void>(resolve => {
      if (monitor.output.length > 0 || monitor.status !== 'running') {
        resolve()
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(checkInterval)
        resolve()
      }
      const checkInterval = setInterval(() => {
        if (monitor.output.length > 0 || monitor.status !== 'running') finish()
      }, 20)
      const timer = setTimeout(finish, 100)
    })

    const initialOutput = [...monitor.output]

    const summary =
      monitor.status === 'error'
        ? 'Monitor command exited with an error. Check the initial output for details.'
        : monitor.status === 'exited'
          ? 'Monitor command finished (exited cleanly). Output captured below.'
          : 'Monitor started successfully. New output will be surfaced as a notification at the start of the next turn. Use MonitorList to check status or MonitorStop to cancel.'

    return {
      data: {
        monitor_id: monitor.id,
        label: monitor.label,
        status: monitor.status,
        summary,
        initial_output: initialOutput,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
