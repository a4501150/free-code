/**
 * Proactive mode state machine.
 *
 * Manages the lifecycle of autonomous "proactive" mode where the agent takes
 * initiative without waiting for user input. The agent receives periodic
 * <tick> prompts and can sleep between them via SleepTool.
 *
 * States: inactive -> active <-> paused
 * contextBlocked prevents tick delivery during compaction/plan mode.
 */

type ProactiveState = 'inactive' | 'active' | 'paused'

let state: ProactiveState = 'inactive'
let contextBlocked = false
let activationSource: string | null = null
const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) {
    cb()
  }
}

/**
 * Whether proactive mode is currently active (not paused, not inactive).
 * Used by SleepTool.isEnabled(), prompt generation, and UI components.
 */
export function isProactiveActive(): boolean {
  return state === 'active'
}

/**
 * Whether proactive mode is paused (user pressed Escape / onCancel).
 * Paused state suppresses tick delivery but preserves activation.
 */
export function isProactivePaused(): boolean {
  return state === 'paused'
}

/**
 * Whether tick delivery is blocked (e.g. during compaction or plan mode).
 */
export function isContextBlocked(): boolean {
  return contextBlocked
}

/**
 * Get the source that activated proactive mode.
 */
export function getProactiveSource(): string | null {
  return activationSource
}

/**
 * Activate proactive mode. Called from --proactive flag, /proactive command,
 * or programmatic activation.
 */
export function activateProactive(source: string): void {
  if (state !== 'inactive' && state !== 'paused') return
  state = 'active'
  activationSource = source
  contextBlocked = false
  notify()
}

/**
 * Deactivate proactive mode entirely. Returns to inactive state.
 */
export function deactivateProactive(): void {
  if (state === 'inactive') return
  state = 'inactive'
  activationSource = null
  contextBlocked = false
  notify()
}

/**
 * Pause proactive mode. Called when user presses Escape (onCancel).
 * Ticks stop but mode stays activated — resumeProactive() resumes.
 */
export function pauseProactive(): void {
  if (state !== 'active') return
  state = 'paused'
  notify()
}

/**
 * Resume proactive mode from paused state. Called when user submits input.
 */
export function resumeProactive(): void {
  if (state !== 'paused') return
  state = 'active'
  notify()
}

/**
 * Block/unblock context for tick delivery. Used during compaction and
 * plan mode to prevent ticks from firing while the system is busy.
 */
export function setContextBlocked(blocked: boolean): void {
  if (contextBlocked === blocked) return
  contextBlocked = blocked
  notify()
}

/**
 * Subscribe to proactive state changes. Follows useSyncExternalStore contract:
 * returns an unsubscribe function, calls subscribers synchronously on change.
 */
export function subscribeToProactiveChanges(
  callback: () => void,
): () => void {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}
