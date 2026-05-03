// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import type { TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

type StopTaskContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

/**
 * Look up a task by ID, validate it is running, and kill it.
 *
 * The kill itself emits the LLM-facing <task-notification> (and the
 * corresponding SDK task_notification event in --print mode), so this
 * function does not have to. Throws {@link StopTaskError} when the task
 * cannot be stopped (not found, not running, or unsupported type). Callers
 * can inspect `error.code` to distinguish the failure reason.
 */
export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const task = appState.tasks?.[taskId] as TaskStateBase | undefined

  if (!task) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, 'not_found')
  }

  if (task.status !== 'running') {
    throw new StopTaskError(
      `Task ${taskId} is not running (status: ${task.status})`,
      'not_running',
    )
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    )
  }

  await taskImpl.kill(taskId, setAppState)

  // Bash tasks: `taskImpl.kill` (killTask) now emits the killed
  // <task-notification> itself (via enqueueShellNotification). In --print
  // mode that XML is parsed and re-emitted as an SDK task_notification (see
  // print.ts:1905+), so we don't need a direct emitTaskTerminatedStructured here —
  // emitting both would double-emit the SDK event. Agent tasks: the
  // AbortError catch in AgentTool.tsx sends a notification carrying
  // extractPartialResult(agentMessages); leave it alone.

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}
