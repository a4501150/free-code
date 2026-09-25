import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitAgentView } from '../state/agentViewHelpers.js'
import { isBackgroundTask } from '../tasks/types.js'

/**
 * Custom hook that handles Shift+Up/Down keyboard navigation for background
 * tasks: opens the background tasks dialog when background work exists.
 * Also handles Escape to exit an agent transcript view.
 */
export function useBackgroundTaskNavigation(options?: {
  onOpenBackgroundTasks?: () => void
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()

  const hasBackgroundTasks = Object.values(tasks).some(t => isBackgroundTask(t))

  const handleKeyDown = (e: KeyboardEvent): void => {
    // Escape in viewing mode: exit the agent transcript view.
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      const task = taskId ? tasks[taskId] : undefined
      if (task?.type === 'local_agent' && task.status === 'running') {
        // Abort the agent's current work (its own abort controller),
        // not the main session's.
        task.abortController?.abort()
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

  // Backward-compat bridge: REPL.tsx doesn't yet wire handleKeyDown to
  // <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until the consumer is migrated (separate PR).
  // TODO(onKeyDown-migration): remove once REPL passes handleKeyDown.
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}
