import * as React from 'react'
import { Box } from '../ink.js'
import { useSubagentTasksV2, useTasksV2 } from '../hooks/useTasksV2.js'
import { useAppState } from '../state/AppState.js'
import { getViewedTeammateTask } from '../state/selectors.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { MessageResponse } from './MessageResponse.js'
import { TaskListV2 } from './TaskListV2.js'

type Props = {
  /** Compaction in flight — the compact progress bar owns the slot below the
   * spinner, so the panel stands down. */
  hidden?: boolean
}

/**
 * The live task-list panel, mounted exactly once in the REPL main slot (below
 * the spinner row). It is deliberately NOT hosted by SpinnerWithVerb: the
 * spinner unmounts several times per turn (streaming text, permission prompts),
 * and a panel hosted inside it was removed and re-inserted as a whole block on
 * every such flip — the bottom-pinned block changed height and the renderer
 * erased-and-rewrote the region (the task-panel "blink"). Hosted here, item
 * updates reconcile in place (TaskListV2 keys rows by task.id) and spinner
 * mount/unmount is a pure row shift above a byte-identical tail, which the
 * log-update shift fast path scrolls instead of repainting.
 */
/**
 * True while the panel is showing the MAIN session's list and every task is
 * completed — i.e. inside the TasksV2Store all-completed display window that
 * ends with the list reset+collapse. The REPL holds the spinner on this so
 * the spinner title and the panel disappear in the same frame. Only the main
 * list: a viewing context renders that agent's list, which has no auto-hide
 * path, so holding on it could pin the spinner indefinitely.
 */
export function useTaskPanelCompletedHold(): boolean {
  const expandedView = useAppState(s => s.expandedView)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const tasksV2 = useTasksV2()
  return (
    !viewingAgentTaskId &&
    expandedView === 'tasks' &&
    tasksV2 !== undefined &&
    tasksV2.length > 0 &&
    tasksV2.every(t => t.status === 'completed')
  )
}

export function TaskLivePanel({ hidden = false }: Props): React.ReactNode {
  const expandedView = useAppState(s => s.expandedView)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const tasks = useAppState(s => s.tasks)
  const mainTasksV2 = useTasksV2()
  const subagentTasksV2 = useSubagentTasksV2(viewingAgentTaskId)

  // Same source rule the spinner used before this panel was extracted: a
  // viewed local agent shows its own list — a viewing context must never
  // borrow the main session's list. Teammates legitimately share the leader's
  // list, so the fallback stays for non-local-agent views.
  const foregroundedTeammate = viewingAgentTaskId
    ? getViewedTeammateTask({ viewingAgentTaskId, tasks })
    : undefined
  const viewedLocalAgent =
    !foregroundedTeammate && viewingAgentTaskId
      ? (() => {
          const t = tasks[viewingAgentTaskId]
          return t && isLocalAgentTask(t) ? t : undefined
        })()
      : undefined
  const tasksV2 = viewedLocalAgent
    ? subagentTasksV2
    : (subagentTasksV2 ?? mainTasksV2)

  if (hidden || expandedView !== 'tasks' || !tasksV2 || tasksV2.length === 0) {
    return null
  }

  return (
    <Box width="100%" flexDirection="column">
      <MessageResponse>
        <TaskListV2 tasks={tasksV2} />
      </MessageResponse>
    </Box>
  )
}
