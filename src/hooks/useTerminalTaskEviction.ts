import * as React from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { isPanelAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { evictTerminalTask } from '../utils/task/framework.js'

/**
 * Evicts terminal agent tasks past their evictAfter deadline, independent of
 * the coordinator panel: in the default TUI the panel never mounts, so a
 * finished subagent's task entry (and any drill-down transcript it retains)
 * would stay in AppState.tasks for the rest of the session. All guards live
 * in evictTerminalTask (terminal + notified + grace + retain), so a task the
 * user is currently viewing is never evicted.
 */
export function useTerminalTaskEviction(): void {
  const tasks = useAppState(s => s.tasks)
  const setAppState = useSetAppState()

  const hasTasks = Object.values(tasks).some(isPanelAgentTask)

  const tasksRef = React.useRef(tasks)
  tasksRef.current = tasks

  React.useEffect(() => {
    if (!hasTasks) return
    const interval = setInterval(
      (tasksRef, setAppState) => {
        const now = Date.now()
        for (const t of Object.values(tasksRef.current)) {
          if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(t.id, setAppState)
          }
        }
      },
      1000,
      tasksRef,
      setAppState,
    )
    return () => clearInterval(interval)
  }, [hasTasks, setAppState])
}
