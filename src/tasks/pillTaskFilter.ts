import { isPanelAgentTask } from './LocalAgentTask/LocalAgentTask.js'
import { isBackgroundTask, type TaskState } from './types.js'

/**
 * The tasks the footer pill counts and lists: background work, minus agent
 * tasks in coordinator mode (those live in the agents panel instead).
 * Callers pass the hoisted coordinator flag so the mode check isn't
 * re-evaluated per element.
 */
export function isPillVisibleTask(
  task: TaskState,
  isCoordinator: boolean,
): boolean {
  return isBackgroundTask(task) && (!isCoordinator || !isPanelAgentTask(task))
}
