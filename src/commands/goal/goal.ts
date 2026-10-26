import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { shouldSkipHookDueToTrust } from '../../utils/hooks.js'
import { areAllHooksDisabled } from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  addSessionHook,
  getSessionHooks,
  removeSessionHook,
} from '../../utils/hooks/sessionHooks.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { HookCommand } from '../../utils/settings/types.js'

const TRUST_GATE_MESSAGE =
  '/goal is only available in trusted workspaces. Accept the trust dialog and try again.'
const HOOKS_GATE_MESSAGE =
  "/goal can't run while hooks are restricted (disableAllHooks is set in settings)."

/**
 * The goal itself rides a session-scoped prompt-type Stop hook: on every stop
 * the utility model evaluates {ok, reason} against the conversation so far.
 * Not met → blocking error keeps the turn going; met → the hook reports
 * success and onHookSuccess clears the goal (CC parity).
 */
function goalDirectiveMessage(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`
}

function findGoalHook(
  appState: AppState,
  sessionId: string,
  condition: string,
): HookCommand | undefined {
  for (const matchers of getSessionHooks(
    appState,
    sessionId,
    'Stop',
  ).values()) {
    for (const matcher of matchers) {
      const hook = matcher.hooks.find(
        h => h.type === 'prompt' && h.prompt === condition,
      )
      if (hook) return hook
    }
  }
  return undefined
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const condition = args.trim()
  const setAppState = context.setAppStateForTasks ?? context.setAppState
  const sessionId = getSessionId()
  const appState = context.getAppState()
  const activeGoal = appState.activeGoal

  if (!condition) {
    onDone(
      activeGoal
        ? `Active goal: ${activeGoal.condition}\nReplace: /goal <condition> · Clear: /goal clear`
        : 'No active goal. Usage: /goal <condition> — keep working until the condition is met.',
      { display: 'system' },
    )
    return null
  }

  const removeGoalHookAndState = (conditionToRemove: string): void => {
    const prevHook = findGoalHook(
      context.getAppState(),
      sessionId,
      conditionToRemove,
    )
    if (prevHook) {
      removeSessionHook(setAppState, sessionId, 'Stop', prevHook)
    }
    setAppState(prev =>
      prev.activeGoal === undefined ? prev : { ...prev, activeGoal: undefined },
    )
  }

  if (condition === 'clear') {
    if (!activeGoal) {
      onDone('No active goal to clear', { display: 'system' })
      return null
    }
    removeGoalHookAndState(activeGoal.condition)
    onDone(`Goal cleared: ${activeGoal.condition}`, { display: 'system' })
    return null
  }

  // Hook execution gates trust and restrictions at the runner; surface the
  // reason at the command instead of silently never firing.
  const gateMessage = areAllHooksDisabled()
    ? HOOKS_GATE_MESSAGE
    : shouldSkipHookDueToTrust()
      ? TRUST_GATE_MESSAGE
      : null
  if (gateMessage) {
    onDone(gateMessage, { display: 'system' })
    return null
  }

  if (activeGoal) {
    removeGoalHookAndState(activeGoal.condition)
  }

  const hook: HookCommand = {
    type: 'prompt',
    prompt: condition,
    statusMessage: 'Checking goal',
  }
  // Fires when the evaluator reports ok:true — the goal is met, so the hook
  // removes itself along with the indicator.
  addSessionHook(setAppState, sessionId, 'Stop', '', hook, () => {
    removeSessionHook(setAppState, sessionId, 'Stop', hook)
    setAppState(prev =>
      prev.activeGoal === undefined ? prev : { ...prev, activeGoal: undefined },
    )
  })
  setAppState(prev => ({
    ...prev,
    activeGoal: { condition, setAt: Date.now() },
  }))
  onDone(`Goal set: ${condition}`, {
    shouldQuery: true,
    metaMessages: [goalDirectiveMessage(condition)],
  })
  return null
}
