/**
 * Host adapter for the coordinator agent panel. Renders below the prompt
 * input footer whenever local_agent tasks exist. Owns the store reads
 * (AppState tasks/registry/selection), the 1s eviction tick, and the
 * view-switching callbacks; delegates rendering to the host-agnostic
 * panels/CoordinatorTaskPanel component.
 */

import * as React from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import { enterAgentView, exitAgentView } from '../state/agentViewHelpers.js'
import {
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { evictTerminalTask } from '../utils/task/framework.js'
import {
  CoordinatorTaskPanel as CoordinatorTaskPanelView,
  type CoordinatorTaskRow,
} from './panels/CoordinatorTaskPanel/CoordinatorTaskPanel.js'
import { isTerminalStatus } from './tasks/taskStatusUtils.js'

/**
 * Which panel-managed tasks currently have a visible row.
 * Presence in AppState.tasks IS visibility — the 1s tick in
 * CoordinatorTaskPanel evicts tasks past their evictAfter deadline. The
 * evictAfter !== 0 check handles immediate dismiss (x key) without making
 * the filter time-dependent. Shared by panel render, useCoordinatorTaskCount,
 * and index resolvers so the math can't drift.
 */
export function getVisibleAgentTasks(
  tasks: AppState['tasks'],
): LocalAgentTaskState[] {
  return Object.values(tasks)
    .filter(
      (t): t is LocalAgentTaskState =>
        isPanelAgentTask(t) && t.evictAfter !== 0,
    )
    .sort((a, b) => a.startTime - b.startTime)
}

export function CoordinatorTaskPanel(): React.ReactNode {
  const tasks = useAppState(s => s.tasks)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const agentNameRegistry = useAppState(s => s.agentNameRegistry)
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex)
  const tasksSelected = useAppState(s => s.footerSelection === 'tasks')
  const selectedIndex = tasksSelected ? coordinatorTaskIndex : undefined
  const setAppState = useSetAppState()

  const hasTasks = Object.values(tasks).some(isPanelAgentTask)

  // 1s tick: re-render for elapsed time + evict tasks past their deadline.
  // The eviction deletes from prev.tasks, which makes useCoordinatorTaskCount
  // (and other consumers) see the updated count without their own tick.
  const tasksRef = React.useRef(tasks)
  tasksRef.current = tasks
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!hasTasks) return
    const interval = setInterval(
      (tasksRef, setAppState, setTick) => {
        const now = Date.now()
        for (const t of Object.values(tasksRef.current)) {
          if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(t.id, setAppState)
          }
        }
        setTick((prev: number) => prev + 1)
      },
      1000,
      tasksRef,
      setAppState,
      setTick,
    )
    return () => clearInterval(interval)
  }, [hasTasks, setAppState])

  const visibleTasks = getVisibleAgentTasks(tasks)
  const nameByAgentId = React.useMemo(() => {
    const inv = new Map<string, string>()
    for (const [n, id] of agentNameRegistry) inv.set(id, n)
    return inv
  }, [agentNameRegistry])

  const rows: CoordinatorTaskRow[] = visibleTasks.map(task => ({
    id: task.id,
    name: nameByAgentId.get(task.id),
    description: task.description,
    summary: task.progress?.summary,
    isRunning: !isTerminalStatus(task.status),
    startTime: task.startTime,
    endTime: task.endTime,
    totalPausedMs: task.totalPausedMs,
    tokenCount: task.progress?.tokenCount,
    hasActivity: task.progress?.lastActivity != null,
    queuedCount: task.pendingMessages.length,
  }))

  return (
    <CoordinatorTaskPanelView
      tasks={rows}
      now={Date.now()}
      selectedIndex={selectedIndex}
      viewedTaskId={viewingAgentTaskId ?? undefined}
      onExitView={() => exitAgentView(setAppState)}
      onEnterView={taskId => enterAgentView(taskId, setAppState)}
    />
  )
}

/**
 * Returns the number of visible coordinator tasks (for selection bounds).
 * The panel's 1s tick evicts expired tasks from prev.tasks, so this count
 * stays accurate without needing its own tick.
 */
export function useCoordinatorTaskCount(): number {
  const tasks = useAppState(s => s.tasks)
  return React.useMemo(() => {
    const count = getVisibleAgentTasks(tasks).length
    return count > 0 ? count + 1 : 0
  }, [tasks])
}
