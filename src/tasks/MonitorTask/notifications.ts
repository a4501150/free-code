/**
 * Monitor notification wiring: when a background monitor produces new
 * output, surface it to the model at the next turn boundary by riding the
 * unified command queue (mode 'task-notification', priority 'later'),
 * exactly like background shell completions. The REPL queue processor
 * dispatches the notice as a new query when the agent is idle; while a
 * query is active the notice waits, and coalescing keeps at most one
 * pending notice per agent so a chatty monitor cannot flood the queue.
 *
 * Notices ride the standard <task-notification> wrapper (same tags the
 * static system prompt documents). Statusless notices are progress pings —
 * print.ts emits an SDK task_notification only when <status> is present,
 * so a running monitor can never falsely close an SDK task. The summary
 * prefix ('Background monitor ') is distinct from
 * BACKGROUND_BASH_SUMMARY_PREFIX ('Background command ') so
 * collapseBackgroundBashNotifications leaves monitor notices alone.
 *
 * This module is also the wiring entry point: wireMonitorNotifications
 * attaches the queue bridge, the per-line disk-output hook and the
 * AppState status mirror (see taskState.ts) to a MonitorManager.
 */
import {
  MONITOR_OUTPUT_TAG,
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
} from '../../constants/xml.js'
import type { SetAppState } from '../../Task.js'
import type { Monitor, MonitorManager } from '../../utils/monitors.js'
import {
  enqueuePendingNotification,
  peek,
} from '../../utils/messageQueueManager.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  appendMonitorOutputLine,
  mirrorMonitorStatus,
  monitorStatusToTaskStatus,
} from './taskState.js'

type NoticeEntry = { monitor: Monitor; output: string[] }

/** Marker distinguishing monitor notices from shell/agent completions
 *  inside the shared <task-notification> wrapper — used by the per-agent
 *  coalescing check so a monitor notice never suppresses a shell notice
 *  or vice versa. */
const MONITOR_TYPE_MARKER = `<${TASK_TYPE_TAG}>monitor</${TASK_TYPE_TAG}>`

function isMonitorNoticeQueued(agentId: string | undefined): boolean {
  const pending = peek(
    cmd =>
      cmd.mode === 'task-notification' &&
      cmd.agentId === agentId &&
      typeof cmd.value === 'string' &&
      cmd.value.includes(MONITOR_TYPE_MARKER),
  )
  return pending !== undefined
}

/** Summary line for a monitor notice. Escaping is unnecessary: the XML
 *  tags are framing for the model, not a parser contract (same as task
 *  notifications). */
function monitorSummaryText(monitor: Monitor): string {
  switch (monitor.status) {
    case 'running':
      return `Background monitor "${monitor.label}" produced new output`
    case 'exited':
      return `Background monitor "${monitor.label}" completed (exit code ${monitor.exitCode ?? 0})`
    case 'error':
      return `Background monitor "${monitor.label}" failed (exit code ${monitor.exitCode ?? -1})`
    case 'stopped':
      return `Background monitor "${monitor.label}" was stopped`
  }
}

/** Render one monitor's new output as a notification section. */
function renderMonitorSection({ monitor, output }: NoticeEntry): string {
  const lines = output.length > 0 ? output : ['(no output)']
  const outputText = lines.map(l => `  ${l}`).join('\n')
  const status = monitorStatusToTaskStatus(monitor)
  // <status> only on terminal transitions: a present <status> is the
  // terminal signal for print.ts and structured consumers, and 'running'
  // is not a status they understand.
  const statusLine =
    status === 'running' ? '' : `\n<${STATUS_TAG}>${status}</${STATUS_TAG}>`
  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${monitor.id}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>monitor</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(monitor.id)}</${OUTPUT_FILE_TAG}>${statusLine}
<${SUMMARY_TAG}>${monitorSummaryText(monitor)}</${SUMMARY_TAG}>
<${MONITOR_OUTPUT_TAG}>
${outputText}
</${MONITOR_OUTPUT_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}

/** Build the full notice text for a set of monitors. Pure and exported for
 *  tests. Tag-first so the prefix-anchored synthetic-message routing in
 *  UserTextMessage classifies it; the guidance prose trails the block
 *  (same shape as the BashTool stall notification). */
export function buildMonitorNoticeText(entries: NoticeEntry[]): string {
  const sections = entries.map(renderMonitorSection).join('\n\n')
  return `${sections}
One or more background monitors produced new output since the last turn. Review the output and react if relevant.`
}

/**
 * Take un-notified monitor output and enqueue one coalesced notice per
 * agent (main thread + each subagent that armed a monitor). A notice is
 * skipped when one is already queued for that agent: its output stays
 * pending in the monitor's newOutput buffer and rides the next notice,
 * so no lines are lost by skipping.
 */
function enqueueMonitorNotices(manager: MonitorManager): void {
  const pendingAgents = new Set(
    manager
      .list()
      .filter(m => m.hasUnnotifiedOutput)
      .map(m => m.agentId),
  )
  for (const agentId of pendingAgents) {
    if (isMonitorNoticeQueued(agentId)) continue
    const entries = manager.takeUnnotifiedOutput(m => m.agentId === agentId)
    if (entries.length === 0) continue
    enqueuePendingNotification({
      value: buildMonitorNoticeText(entries),
      mode: 'task-notification',
      // 'later' = end-of-turn drain: dispatched as a new query when the
      // agent is idle, never starving user input (same as task
      // completions). agentId routes subagent monitors through the
      // query.ts drain gate so they cannot leak into the main thread.
      priority: 'later',
      ...(agentId !== undefined ? { agentId } : {}),
    })
  }
}

const wiredManagers = new WeakSet<MonitorManager>()

/** Idempotently attach the bridges to a MonitorManager: queue notices on
 *  output, disk streaming per line, AppState status mirroring. Called from
 *  the Monitor tool's call(); nothing needs wiring until the first monitor
 *  exists. Per-manager (not module-level) so a stopAll'd manager that is
 *  re-armed can be wired again. The first caller's setAppState wins —
 *  background-task infrastructure uses the shared-root setter
 *  (context.setAppStateForTasks ?? context.setAppState), which is stable
 *  for the session. */
export function wireMonitorNotifications(
  manager: MonitorManager,
  setAppState: SetAppState,
): void {
  if (wiredManagers.has(manager)) return
  wiredManagers.add(manager)
  manager.onOutput(() => enqueueMonitorNotices(manager))
  manager.onLine(appendMonitorOutputLine)
  manager.onStatusChange(monitor => mirrorMonitorStatus(monitor, setAppState))
}
