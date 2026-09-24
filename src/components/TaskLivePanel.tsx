import * as React from 'react'
import { Box } from '../ink.js'
import { useTasksV2 } from '../hooks/useTasksV2.js'
import { useAppState } from '../state/AppState.js'
import type { Task } from '../utils/tasks.js'
import { MessageResponse } from './MessageResponse.js'
import { TaskListV2 } from './TaskListV2.js'

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

/**
 * The live task-list rows, hosted by every SpinnerWithVerb variant (never
 * mounted standalone): the panel is visible only while the spinner block is
 * up, so its lifetime needs no coordination of its own — the spinner decides
 * visibility and the panel only applies its extra stand-downs (a compacting
 * agent on screen, and the store's all-completed window ending in the list
 * reset+collapse, which also collapses expandedView).
 *
 * Renders FLUSH under the spinner row — no margin of its own. The spinner
 * owns the one blank separator row against the messages (constant, not
 * conditional on panel visibility), which makes a panel appear/disappear a
 * pure append/truncate at the block's bottom edge: the top edge never moves,
 * so the log-update shift fast path scrolls instead of repainting
 * (tests/e2e/thinking-swap-repaint.test.ts guards this).
 *
 * Item updates reconcile in place (TaskListV2 keys rows by task.id), and
 * because the spinner now stays mounted for the whole busy stretch
 * (1d8a197), the block is only ever removed and re-inserted as a whole at
 * genuine turn boundaries — which is what justified extracting this panel
 * out of SpinnerWithVerb before, and no longer does.
 */
export function TaskPanelRows({ tasks }: { tasks: Task[] }): React.ReactNode {
  return (
    <Box width="100%" flexDirection="column">
      <MessageResponse>
        <TaskListV2 tasks={tasks} />
      </MessageResponse>
    </Box>
  )
}
