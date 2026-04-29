// Pure (non-React) kill helpers for LocalShellTask.
// Extracted so runAgent.ts can kill agent-scoped bash tasks without pulling
// React/Ink into its module graph (same rationale as guards.ts).

import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { type BashTaskKind, isLocalShellTask } from './guards.js'
import { enqueueShellNotification } from './notifications.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export function killTask(taskId: string, setAppState: SetAppStateFn): void {
  // Capture the fields needed for the post-kill notification before the state
  // update transitions the task to 'killed' (and clears `shellCommand` etc.).
  let notificationArgs: {
    description: string
    toolUseId?: string
    kind: BashTaskKind | undefined
    agentId?: AgentId
  } | null = null

  updateTaskState(taskId, setAppState, task => {
    if (task.status !== 'running' || !isLocalShellTask(task)) {
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

  if (notificationArgs) {
    const args: {
      description: string
      toolUseId?: string
      kind: BashTaskKind | undefined
      agentId?: AgentId
    } = notificationArgs
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
