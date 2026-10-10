import { useAppState } from '../state/AppState.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Task } from '../utils/tasks.js'
import { useSubagentTasksV2, useTasksV2 } from './useTasksV2.js'

/**
 * The task list for whatever view is currently active, shared by the spinner
 * panel and the idle task panel: viewing a local agent shows that agent's own
 * list, never the main session's (the main session's todos would render as
 * the agent's). Concurrent agents legitimately share the leader's list, so
 * the fallback stays for non-local-agent views.
 */
export function useViewedTaskList(): {
  viewedLocalAgent: LocalAgentTaskState | undefined
  tasksV2: Task[] | undefined
} {
  const tasks = useAppState(s => s.tasks)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const viewedLocalAgent = viewingAgentTaskId
    ? (() => {
        const t = tasks[viewingAgentTaskId]
        return isLocalAgentTask(t) ? t : undefined
      })()
    : undefined
  const mainTasksV2 = useTasksV2()
  const subagentTasksV2 = useSubagentTasksV2(viewingAgentTaskId)
  const tasksV2 = viewedLocalAgent
    ? subagentTasksV2
    : (subagentTasksV2 ?? mainTasksV2)
  return { viewedLocalAgent, tasksV2 }
}
