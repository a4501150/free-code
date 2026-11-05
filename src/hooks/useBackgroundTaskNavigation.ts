import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  exitAgentView,
  getScopedBackgroundTasks,
} from '../state/agentViewHelpers.js'
import { agentToolInterruptReason } from '../tools/AgentTool/agentPark.js'
import { isBackgroundTask } from '../tasks/types.js'

/**
 * Custom hook that handles Shift+Up/Down keyboard navigation for background
 * tasks: opens the background tasks dialog when background work exists.
 * Also handles Escape in an agent transcript view: interrupt the viewed
 * agent's in-flight tool (run survives, parks) or, when nothing is in
 * flight, exit the view.
 */
export function useBackgroundTaskNavigation(options?: {
  onOpenBackgroundTasks?: () => void
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()

  // In agent transcript view, only the viewed agent's own background work
  // counts — the dialog shows the scoped set, so the shortcut must match.
  const hasBackgroundTasks = Object.values(
    getScopedBackgroundTasks(tasks, viewingAgentTaskId),
  ).some(t => isBackgroundTask(t))

  const handleKeyDown = (e: KeyboardEvent): void => {
    // Escape in viewing mode, state-based:
    // - running and mid-round → interrupt the agent's in-flight tool only
    //   (the agentId-addressed abort reason; runAgent re-arms and parks, the
    //   run and its owned background tasks survive, the parent is not
    //   notified). Stay in the view — the interrupt marker lands in the
    //   transcript the user is looking at.
    // - running but parked (no in-flight tool) or not running → exit the
    //   view. The run, if any, keeps going in the background; killing it is
    //   a deliberate gesture (panel 'x', the kill-agents chord, Ctrl+C).
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      const task = taskId ? tasks[taskId] : undefined
      if (
        task?.type === 'local_agent' &&
        task.status === 'running' &&
        !task.parked
      ) {
        task.abortController?.abort(agentToolInterruptReason(task.agentId))
        return
      }
      exitAgentView(setAppState)
      return
    }

    // Shift+Up/Down opens the background tasks dialog when there is
    // background work to inspect.
    if (e.shift && (e.key === 'up' || e.key === 'down')) {
      e.preventDefault()
      if (hasBackgroundTasks) {
        options?.onOpenBackgroundTasks?.()
      }
      return
    }
  }

  // handleKeyDown is consumed by the REPL via PromptKeyDownContext — it
  // runs on the prompt container's onKeyDown, before any useInput
  // listener. Handler only preventDefault()s (never consumes), so the
  // input emitter still fires for the same key — callers rely on that
  // (e.g. onSubmit's selecting-agent guard skips the double submit).

  return { handleKeyDown }
}
