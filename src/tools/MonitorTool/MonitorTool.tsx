import { z } from 'zod/v4'
import type { DomainToolResultBlockParam } from '../../types/domain.js'
import type { ToolDef, ToolUseContext } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getMonitorManager } from '../../utils/monitors.js'
import { isBackgroundTasksEnabled } from '../../utils/backgroundTasks.js'
import {
  notifyIntervalError,
  parseNotifyIntervalMs,
} from '../../utils/parseNotifyInterval.js'
import { wireMonitorNotifications } from '../../tasks/MonitorTask/notifications.js'
import { registerMonitorTaskState } from '../../tasks/MonitorTask/taskState.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { truncate } from '../../utils/format.js'
import { BACKGROUND_TASK_STOP_TOOL_NAME } from '../BackgroundTaskStopTool/prompt.js'
import { bashToolHasPermission } from '../BashTool/bashPermissions.js'
import type { ValidationResult } from '../../Tool.js'
import { MONITOR_TOOL_NAME } from './toolName.js'
import { getMonitorPrompt } from './prompt.js'
import { MonitorPermissionRequest } from './MonitorPermissionRequest.js'

const inputSchema = z.strictObject({
  command: z
    .string()
    .describe(
      'The shell command to run detached as the watch. Poll world state and print only when the verdict changes.',
    ),
  description: z
    .string()
    .optional()
    .describe(
      'Short human-readable label for this monitor, e.g. "watch CI run 1234". Shown in task notifications and the background tasks UI.',
    ),
  notify_interval: z
    .string()
    .describe(
      'Maximum notification cadence: a positive number followed by s, m, or h (e.g. "90s", "5m", "1h").',
    ),
})
type InputSchema = typeof inputSchema

export type MonitorToolInput = z.infer<typeof inputSchema>

const outputSchema = z.object({
  stdout: z
    .string()
    .describe(
      'Output lines captured before the tool returned (usually empty; may hold an immediate failure)',
    ),
  monitorTaskId: z
    .string()
    .describe('ID of the started monitor, usable with BackgroundTaskStop'),
})
type OutputSchema = typeof outputSchema
export type MonitorOut = z.infer<typeof outputSchema>

/** Display label for a monitor: the caller's description, else the command. */
function monitorLabel(input: {
  description?: string
  command?: string
}): string {
  return (
    input.description ?? truncate(input.command ?? '', TOOL_SUMMARY_MAX_LENGTH)
  )
}

export const MonitorTool = buildTool({
  renderPermissionRequest: () => MonitorPermissionRequest,

  name: MONITOR_TOOL_NAME,
  maxResultSizeChars: 30_000,
  async description(input) {
    return `Monitor ${monitorLabel(input)}`
  },
  async prompt() {
    return getMonitorPrompt()
  },
  isConcurrencySafe() {
    return false
  },
  // A monitor is a never-returning detached command — never read-only
  // (a false positive feeds memory extraction and speculation approval).
  isReadOnly() {
    return false
  },
  // Monitors are background processes, like the Bash tool's
  // run_in_background: removed entirely when the backgroundTasksEnabled
  // setting is off (the Bash prompt's watch guidance then points nowhere).
  isEnabled() {
    return isBackgroundTasksEnabled()
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema
  },
  compactParamKeys: ['description', 'command'],
  userFacingName() {
    return 'Monitor'
  },
  getToolUseSummary(input) {
    if (!input?.command) {
      return null
    }
    return input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH)
  },
  getActivityDescription(input) {
    const desc =
      input?.description ??
      truncate(input?.command ?? '', TOOL_SUMMARY_MAX_LENGTH)
    return `Monitoring ${desc}`
  },
  async validateInput(input: MonitorToolInput): Promise<ValidationResult> {
    if (parseNotifyIntervalMs(input.notify_interval) === undefined) {
      return {
        result: false,
        message: notifyIntervalError(input.notify_interval),
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(
    input: MonitorToolInput,
    context: ToolUseContext,
  ): Promise<PermissionResult> {
    // Monitor commands run shell commands, so they go through the exact Bash
    // permission pipeline (AST security parse, redirect checks, permission
    // rules). bashToolHasPermission only reads input.command.
    return bashToolHasPermission({ command: input.command }, context).then(
      result =>
        // bashToolHasPermission echoes its argument back as updatedInput on
        // some branches; that echo is the narrowed {command} object. The
        // executor adopts updatedInput as the input for call(), so without
        // this re-attach call() would see notify_interval missing.
        'updatedInput' in result && result.updatedInput !== undefined
          ? { ...result, updatedInput: input }
          : result,
    )
  },
  renderToolUseMessage(input) {
    const label = input.description ?? input.command ?? ''
    return `Starting monitor: ${label}`
  },
  renderToolResultMessage(output: MonitorOut) {
    const tail = output.stdout ? `\n${output.stdout}` : ''
    return `Monitor started (id: ${output.monitorTaskId})${tail}`
  },
  mapToolResultToToolResultBlockParam(
    { stdout, monitorTaskId }: MonitorOut,
    toolUseID: string,
  ): DomainToolResultBlockParam {
    const started = `Monitor started with ID: ${monitorTaskId}. It runs detached; whenever the latest output line changes you will get a system task notification in a later turn (at most once per the requested interval) — you do not need to wait or poll. Full output file: ${getTaskOutputPath(monitorTaskId)}. Stop it with ${BACKGROUND_TASK_STOP_TOOL_NAME}.`
    const content = [stdout.trim(), started].filter(Boolean).join('\n')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
      is_error: false,
    }
  },
  async call(
    input: MonitorToolInput,
    context: ToolUseContext,
  ): Promise<{ data: MonitorOut }> {
    // validateInput has already verified the interval parses — the throw
    // below is defense against callers that skip it.
    const notifyIntervalMs = parseNotifyIntervalMs(input.notify_interval)
    if (notifyIntervalMs === undefined) {
      throw new Error(notifyIntervalError(input.notify_interval))
    }
    const manager = getMonitorManager()
    const setAppState = context.setAppStateForTasks ?? context.setAppState
    wireMonitorNotifications(manager, setAppState)

    const label =
      input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH)
    const monitor = manager.start(input.command, label, {
      agentId: context.agentId,
      notifyIntervalMs,
    })
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

    return {
      data: {
        stdout: [...monitor.output].join('\n'),
        monitorTaskId: monitor.id,
      },
    }
  },
} satisfies ToolDef<InputSchema, MonitorOut>)
