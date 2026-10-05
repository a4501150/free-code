/**
 * Monitor notification wiring: when a background monitor produces new
 * output, surface it to the model at the next turn boundary by riding the
 * unified command queue (mode 'task-notification', priority 'later'),
 * exactly like background shell completions. The REPL queue processor
 * dispatches the notice as a new query when the agent is idle; while a
 * query is active the notice waits, and coalescing keeps at most one
 * pending notice per agent so a chatty monitor cannot flood the queue.
 *
 * Snipe equivalent: agent-session.ts injects buildMonitorNotice() output
 * into turn-start message building and auto-prompts when idle. free-code
 * has no single session object to hook, so the queue is the delivery
 * mechanism (see src/utils/task/framework.ts enqueueTaskNotification for
 * the pattern this follows).
 */
import {
  MONITOR_ID_TAG,
  MONITOR_LABEL_TAG,
  MONITOR_NOTIFICATION_TAG,
  MONITOR_OUTPUT_TAG,
  STATUS_TAG,
} from '../../constants/xml.js'
import type { Monitor, MonitorManager } from '../../utils/monitors.js'
import {
  enqueuePendingNotification,
  peek,
} from '../../utils/messageQueueManager.js'

type NoticeEntry = { monitor: Monitor; output: string[] }

function isMonitorNoticeQueued(agentId: string | undefined): boolean {
  const pending = peek(
    cmd =>
      cmd.mode === 'task-notification' &&
      cmd.agentId === agentId &&
      typeof cmd.value === 'string' &&
      cmd.value.startsWith(`<${MONITOR_NOTIFICATION_TAG}>`),
  )
  return pending !== undefined
}

/** Render one monitor's new output as a notification section. Escaping is
 *  unnecessary: the XML tags are framing for the model, not a parser
 *  contract (same as task notifications). */
function renderMonitorSection({ monitor, output }: NoticeEntry): string {
  const lines = output.length > 0 ? output : ['(no output)']
  const outputText = lines.map(l => `  ${l}`).join('\n')
  return `<${MONITOR_NOTIFICATION_TAG}>
<${MONITOR_ID_TAG}>${monitor.id}</${MONITOR_ID_TAG}>
<${MONITOR_LABEL_TAG}>${monitor.label}</${MONITOR_LABEL_TAG}>
<${STATUS_TAG}>${monitor.status}</${STATUS_TAG}>
<${MONITOR_OUTPUT_TAG}>
${outputText}
</${MONITOR_OUTPUT_TAG}>
</${MONITOR_NOTIFICATION_TAG}>`
}

/** Build the full notice text for a set of monitors. Pure and exported for
 *  tests. */
export function buildMonitorNoticeText(entries: NoticeEntry[]): string {
  const sections = entries.map(renderMonitorSection).join('\n\n')
  return `One or more background monitors produced new output since the last turn. Review the output and react if relevant.\n\n${sections}`
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

/** Idempotently attach the queue bridge to a MonitorManager. Called from
 *  the Monitor tool's call(); nothing needs wiring until the first monitor
 *  exists. Per-manager (not module-level) so a stopAll'd manager that is
 *  re-armed can be wired again. */
export function wireMonitorNotifications(manager: MonitorManager): void {
  if (wiredManagers.has(manager)) return
  wiredManagers.add(manager)
  manager.onOutput(() => enqueueMonitorNotices(manager))
}
