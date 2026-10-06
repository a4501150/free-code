/**
 * AppState mirror for background monitors.
 *
 * Monitors run in the in-memory MonitorManager (src/utils/monitors.ts),
 * which the background-task UI (BackgroundTasksDialog, footer pill) cannot
 * see. This module registers each monitor as a local_bash task state with
 * `kind: 'monitor'` — the display variant the task UI already knows: the
 * dialog shows a "Monitor details" view, the pill counts monitors separately
 * from shells, and rows show the label instead of the raw command — and
 * streams the monitor's output lines to the task's disk output file so the
 * detail view can tail them live.
 *
 * The mirror is driven entirely by the MonitorManager hooks wired in
 * monitorNotifications.ts; it never touches the monitor process itself.
 */
import { type SetAppState, createTaskStateBase } from '../../Task.js'
import type { Monitor } from '../../utils/monitors.js'
import { DiskTaskOutput } from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import type { LocalShellTaskState } from '../LocalShellTask/guards.js'

/** Map a monitor's status to the TaskStatus vocabulary shared by the
 *  AppState mirror and the notice's <status> tag. */
export function monitorStatusToTaskStatus(
  monitor: Monitor,
): LocalShellTaskState['status'] {
  switch (monitor.status) {
    case 'running':
      return 'running'
    case 'exited':
      return 'completed'
    case 'error':
      return 'failed'
    case 'stopped':
      return 'killed'
  }
}

// One DiskTaskOutput per live monitor, keyed by monitor id. DiskTaskOutput
// buffers internally, so a per-line append is cheap. Entries are dropped
// (after a flush) when the monitor terminates; the file itself stays on
// disk for the output-file pointer in notices.
const diskOutputs = new Map<string, DiskTaskOutput>()

/** Append one monitor output line to the task's disk output file. Fired
 *  per line via MonitorManager.onLine. Late lines buffered in the child's
 *  pipe after termination are still written if the entry hasn't been
 *  flushed yet; once it has, there is nothing to append to. */
export function appendMonitorOutputLine(monitor: Monitor, line: string): void {
  let out = diskOutputs.get(monitor.id)
  if (!out) {
    if (monitor.status !== 'running') return
    out = new DiskTaskOutput(monitor.id)
    diskOutputs.set(monitor.id, out)
  }
  out.append(`${line}\n`)
}

/** Flush and drop the monitor's disk buffer. The output file itself is
 *  deliberately kept: notices carry its path so the model can read the
 *  full output after the monitor is gone. */
function flushMonitorDiskOutput(monitorId: string): void {
  const out = diskOutputs.get(monitorId)
  if (!out) return
  diskOutputs.delete(monitorId)
  void out.flush()
}

/** Register the AppState mirror for a freshly started monitor. Called from
 *  the Monitor tool's call(). If the spawn already failed synchronously the
 *  mirror is born terminal, so it is GC-evicted like any other notified
 *  task instead of ghosting as running in the dialog. */
export function registerMonitorTaskState(
  monitor: Monitor,
  setAppState: SetAppState,
  toolUseId?: string,
): void {
  const status = monitorStatusToTaskStatus(monitor)
  const terminal = status !== 'running'
  const taskState: LocalShellTaskState = {
    ...createTaskStateBase(monitor.id, 'local_bash', monitor.label, toolUseId),
    type: 'local_bash',
    status,
    command: monitor.command,
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    agentId: monitor.agentId,
    kind: 'monitor',
    ...(terminal
      ? {
          result: { code: monitor.exitCode ?? -1, interrupted: false },
          endTime: monitor.endedAt ?? Date.now(),
          notified: true,
        }
      : {}),
  }
  registerTask(taskState, setAppState)
  if (terminal) flushMonitorDiskOutput(monitor.id)
}

/** Mirror a monitor's terminal transition into AppState. Idempotent: a
 *  mirror that already left 'running' is left untouched (the manager's
 *  finalize guard means late events don't re-fire, but killTask's monitor
 *  path and the status hook can interleave). */
export function mirrorMonitorStatus(
  monitor: Monitor,
  setAppState: SetAppState,
): void {
  const status = monitorStatusToTaskStatus(monitor)
  if (status === 'running') return
  updateTaskState<LocalShellTaskState>(monitor.id, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      status,
      result: { code: monitor.exitCode ?? -1, interrupted: false },
      endTime: monitor.endedAt ?? Date.now(),
      notified: true,
    }
  })
  flushMonitorDiskOutput(monitor.id)
}
