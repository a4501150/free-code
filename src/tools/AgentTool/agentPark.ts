// Park-and-wait for subagents that ended a round while still owning running
// background tasks (strict end_turn model — an implicit end is not a
// completion). React-free and dependency-light so runAgent and unit tests
// can import it without pulling ink.

import type { AgentId } from '../../types/ids.js'
import {
  isAgentTaskNotification,
  someCommand,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js'

/** Idle time before the first "still waiting" reminder round. */
export const PARK_INITIAL_IDLE_MS = 10 * 60 * 1000
/** Cap for the exponential idle backoff (10 → 20 → 40 → 60 min). */
export const PARK_MAX_IDLE_MS = 60 * 60 * 1000
/**
 * Backstop for the strict end_turn model: consecutive implicit ends with no
 * owned tasks and no EndTurn call after this many reminders force-complete
 * the run (mirrors the silent maxTurns end; the delivered result skips
 * post-nudge ack text — see finalizeAgentTool's extraction).
 */
export const MAX_END_REMINDERS = 2

export type ParkWake = 'signal' | 'idle' | 'abort'

/**
 * Wait until something happens that a parked agent should look at:
 * - 'signal': a queued command is addressed to this agent (a task
 *   notification) or its pendingMessages grew (SendMessage traffic).
 *   Subscribers fire on EVERY queue mutation, so the predicate re-checks
 *   and keeps waiting when the change was for someone else.
 * - 'idle': the backoff timer elapsed — the caller sends a reminder round.
 * - 'abort': the run's abort signal fired.
 */
export function parkUntilOwnedTaskSignal(opts: {
  agentId: AgentId
  idleMs: number
  abortSignal: AbortSignal
  /** pendingMessages count on the agent's own task entry (0 when absent). */
  getPendingMessageCount: () => number
}): Promise<ParkWake> {
  // An already-aborted signal never fires the listener — check up front or
  // the park would sit until the idle timer.
  if (opts.abortSignal.aborted) return Promise.resolve('abort')
  return new Promise(resolve => {
    let settled = false
    const cleanup = () => {
      unsubscribe()
      clearTimeout(timer)
      opts.abortSignal.removeEventListener('abort', onAbort)
    }
    const done = (wake: ParkWake) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(wake)
    }
    const checkForSignal = () => {
      // Same predicate the wake path drains with (isAgentTaskNotification):
      // waking on a command the drain won't take would burn a model round.
      const hasNotification = someCommand(cmd =>
        isAgentTaskNotification(cmd, opts.agentId),
      )
      if (hasNotification || opts.getPendingMessageCount() > 0) {
        done('signal')
      }
    }
    const onAbort = () => done('abort')
    const unsubscribe = subscribeToCommandQueue(checkForSignal)
    const timer = setTimeout(() => done('idle'), opts.idleMs)
    opts.abortSignal.addEventListener('abort', onAbort, { once: true })
    // A signal may already be queued before we park.
    checkForSignal()
  })
}
