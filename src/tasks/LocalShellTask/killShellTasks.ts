// Pure (non-React) kill helpers for LocalShellTask.
// Extracted so runAgent.ts can kill agent-scoped bash tasks without pulling
// React/Ink into its module graph (same rationale as guards.ts).

import {
  currentSessionState,
  runInSessionScope,
  type SessionState,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { type BashTaskKind, isLocalShellTask } from './guards.js'
import type { LocalShellTaskState } from './guards.js'
import { enqueueShellNotification } from './notifications.js'
import { getMonitorManager } from '../../utils/monitors.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

// The session scope each shell task was spawned in. A kill can arrive from
// outside that scope — the hosted TUI mounts the classic task dialogs in the
// viewer's root scope, and the command queue is session-scoped — so the
// killed <task-notification> must land in the OWNING session's queue, not
// the killer's. In a single-scope process the recorded state is the root
// scope and the wrap is identity.
const taskOwnerScope = new Map<string, SessionState>()

/** Record the session scope a task was spawned in (call at spawn time). */
export function recordTaskOwnerScope(taskId: string): void {
  taskOwnerScope.set(taskId, currentSessionState())
}

/** Drop a recorded scope once the task reached a terminal, notified state. */
export function forgetTaskOwnerScope(taskId: string): void {
  taskOwnerScope.delete(taskId)
}

export function killTask(taskId: string, setAppState: SetAppStateFn): void {
  // Capture the fields needed for the post-kill notification before the state
  // update transitions the task to 'killed' (and clears `shellCommand` etc.).
  let notificationArgs: {
    description: string
    toolUseId?: string
    kind: BashTaskKind | undefined
    agentId?: AgentId
  } | null = null
  let isMonitor = false

  // Resolved before the state update: a concurrent completion may forget
  // the entry as part of its terminal transition.
  const owner = taskOwnerScope.get(taskId) ?? currentSessionState()
  taskOwnerScope.delete(taskId)

  updateTaskState(taskId, setAppState, task => {
    if (task.status !== 'running' || !isLocalShellTask(task)) {
      return task
    }
    if (task.kind === 'monitor') {
      // The MonitorManager owns the process; stopping it drives the mirror
      // transition and the terminal monitor notice via its hooks. No shell
      // <task-notification> here — it would duplicate the monitor notice.
      isMonitor = true
      return task
    }

    try {
      logForDebugging(`LocalShellTask ${taskId} kill requested`)
      task.shellCommand?.kill()
      task.shellCommand?.cleanup()
    } catch (error) {
      logError(error)
    }

    task.unregisterCleanup?.()
    if (task.cleanupTimeoutId) {
      clearTimeout(task.cleanupTimeoutId)
    }

    notificationArgs = {
      description: task.description,
      toolUseId: task.toolUseId,
      kind: task.kind,
      agentId: task.agentId,
    }

    return {
      ...task,
      status: 'killed',
      // `notified` is intentionally NOT set here. The follow-up
      // `enqueueShellNotification` call below sets `notified: true`
      // atomically as part of its enqueue (see notifications.ts) so the
      // existing duplicate-suppression contract is preserved while the
      // killed notification actually reaches the LLM.
      shellCommand: null,
      unregisterCleanup: undefined,
      cleanupTimeoutId: undefined,
      endTime: Date.now(),
    }
  })

  if (isMonitor) {
    // Side effects stay out of the state updater (same pattern as the
    // cleanup call in backgroundTask). If the manager no longer knows the
    // monitor — it shouldn't happen while the mirror is running — mark the
    // mirror killed anyway so it can't ghost in the dialog.
    if (!getMonitorManager().stop(taskId)) {
      updateTaskState<LocalShellTaskState>(taskId, setAppState, task =>
        task.status === 'running'
          ? {
              ...task,
              status: 'killed',
              endTime: Date.now(),
              notified: true,
              shellCommand: null,
            }
          : task,
      )
    }
    return
  }

  if (notificationArgs) {
    const args: {
      description: string
      toolUseId?: string
      kind: BashTaskKind | undefined
      agentId?: AgentId
    } = notificationArgs
    // Enqueue against the task's own session scope (see taskOwnerScope):
    // a viewer-originated kill runs unscoped, but the notification must
    // sit in the queue the owning session's drain loop reads.
    runInSessionScope(owner, () => {
      enqueueShellNotification(
        taskId,
        args.description,
        'killed',
        undefined,
        setAppState,
        args.toolUseId,
        args.kind,
        args.agentId,
      )
    })
  }

  void evictTaskOutput(taskId)
}

/**
 * Kill all running bash tasks spawned by a given agent.
 * Called from runAgent.ts finally block so background processes don't outlive
 * the agent that started them (prevents 10-day fake-logs.sh zombies).
 */
export function killShellTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killShellTasksForAgent: killing orphaned shell task ${taskId} (agent ${agentId} exiting)`,
      )
      killTask(taskId, setAppState)
    }
  }
  // Purge any queued notifications addressed to this agent — its query loop
  // has exited and won't drain them. killTask fires 'killed' notifications
  // asynchronously; drop the ones already queued and any that land later sit
  // harmlessly (no consumer matches a dead agentId).
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
