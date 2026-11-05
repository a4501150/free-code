// Park-and-wait for subagents that ended a round while still owning running
// background tasks (strict end_turn model — an implicit end is not a
// completion). React-free and dependency-light so runAgent and unit tests
// can import it without pulling ink.

import type { AgentId } from '../../types/ids.js'
import type { TaskState } from '../../tasks/types.js'
import {
  FINISH_RUN_REMINDER_TAG,
  FINISH_RUN_TOOL_NAME,
} from '../FinishRunTool/constants.js'
import { BACKGROUND_TASK_STOP_TOOL_NAME } from '../BackgroundTaskStopTool/prompt.js'
import {
  isAgentTaskNotification,
  someCommand,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js'

/**
 * Abort-reason prefix for a user's interrupt of one running agent's
 * in-flight tool (Esc in the drill-down view). Unlike a default abort (run
 * death: the finally block kills owned background tasks and the parent is
 * notified), runAgent treats this reason as round-scoped — but only for the
 * agent it names: the reason carries the target's agentId because sync
 * children share their parent's controller and must die with it, not adopt
 * the parent's interrupt as their own.
 */
export const AGENT_TOOL_INTERRUPT_PREFIX = 'tool-interrupt'

/**
 * The abort reason the drill-down Esc handler passes for `agentId`'s run.
 * Takes a plain string: the task registry keys agents by unbranded id.
 */
export function agentToolInterruptReason(agentId: string): string {
  return `${AGENT_TOOL_INTERRUPT_PREFIX}:${agentId}`
}

/** Whether `reason` is a tool-interrupt addressed to `agentId`'s run. */
export function isAgentToolInterruptReason(
  reason: unknown,
  agentId: string,
): boolean {
  return reason === agentToolInterruptReason(agentId)
}

/** Idle time before the first "still waiting" reminder round. */
export const PARK_INITIAL_IDLE_MS = 10 * 60 * 1000
/** Cap for the exponential idle backoff (10 → 20 → 40 → 60 min). */
export const PARK_MAX_IDLE_MS = 60 * 60 * 1000
/**
 * Backstop for the strict end_turn model: consecutive implicit ends with no
 * owned tasks and no FinishRun call after this many reminders force-complete
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

/** What runAgent does with a round that ended on a FinishRun call. */
export type FinishRunOwnedTasksGate = 'honor' | 'gate'

/**
 * Decision for a round that ended on an explicit FinishRun while the agent
 * still owns running background tasks. Models call FinishRun to "pause" for a
 * build (two live port agents wrote "I'll wait for the build to complete"
 * and called FinishRun — a true completion that killed their builds), so the
 * strict end_turn model must gate the explicit call too, not just implicit
 * ends.
 *
 * - 'honor': end the run — no owned tasks, the turns budget is exhausted, or
 *   this is the second consecutive no-work FinishRun with the same tasks (a
 *   deliberate choice to abandon them; the first gated round told the model
 *   exactly that).
 * - 'gate': convert to a reminder round (finishRunOwnedTasksReminderText) and
 *   let the park machinery wait for the tasks.
 *
 * A round that did work before the FinishRun answered the previous gate —
 * only consecutive no-work FinishRun calls count as the second strike, mirroring
 * consecutiveEndReminders in runAgent.
 */
export function resolveFinishRunOwnedTasksGate(opts: {
  ownedTaskCount: number
  /** Strike count carried across rounds (gated FinishRun calls in a row). */
  strikes: number
  /** Whether the ending round did work before the FinishRun call. */
  roundDidWork: boolean
  /** Turns budget exhausted (turnsUsed >= totalMaxTurns). */
  overBudget: boolean
}): FinishRunOwnedTasksGate {
  if (opts.ownedTaskCount === 0 || opts.overBudget) return 'honor'
  if (!opts.roundDidWork && opts.strikes >= 1) return 'honor'
  return 'gate'
}

/** One `- id (kind): what` line per owned task, shared by both reminders. */
function ownedTaskListLines(tasks: TaskState[]): string {
  return tasks
    .map(task => {
      const kind =
        task.type === 'local_bash' && task.kind ? task.kind : 'background'
      const what =
        task.type === 'local_bash'
          ? (task.command ?? task.description)
          : task.description
      return `- ${task.id} (${kind}): ${what}`
    })
    .join('\n')
}

/**
 * Reminder texts for the strict end_turn model: isMeta user messages that
 * ride the conversation, the sidechain transcript and the drill-down (the
 * outbox in runAgent delivers them). Both are wrapped in
 * FINISH_RUN_REMINDER_TAG so the UI renders them as visible reminder rows;
 * only FINISH_RUN_REMINDER itself (exact text, from FinishRunTool/constants)
 * triggers the post-nudge ack skip in finalizeAgentTool — a reply to either
 * of these is a genuine decision, not protocol noise.
 */
export function ownedTasksReminderText(
  tasks: TaskState[],
  idle = false,
): string {
  const lead = idle
    ? `Still waiting on ${tasks.length} background task(s) you own:\n${ownedTaskListLines(tasks)}`
    : `You ended your message while still owning ${tasks.length} running background task(s):\n${ownedTaskListLines(tasks)}`
  return `<${FINISH_RUN_REMINDER_TAG}>\n${lead}\nWait for them to finish (their notifications are delivered to you), stop them with ${BACKGROUND_TASK_STOP_TOOL_NAME}, or call ${FINISH_RUN_TOOL_NAME} to end your run — ending it kills the tasks you still own.\n</${FINISH_RUN_REMINDER_TAG}>`
}

/**
 * The gated FinishRun's reminder. "Not carried out" must be unambiguous: the
 * model just saw FinishRun's own tool result, so the reminder corrects it
 * head-on, and the second-strike contract ("call it again to end now")
 * keeps the gate from trapping an agent that genuinely wants out.
 */
export function finishRunOwnedTasksReminderText(tasks: TaskState[]): string {
  return `<${FINISH_RUN_REMINDER_TAG}>\nYour ${FINISH_RUN_TOOL_NAME} call was not carried out: you still own ${tasks.length} running background task(s), and ending your run kills them.\n${ownedTaskListLines(tasks)}\nTo wait for them, end your message WITHOUT calling ${FINISH_RUN_TOOL_NAME} — your run stays open and their completion notifications are delivered to you. To abandon them, stop them with ${BACKGROUND_TASK_STOP_TOOL_NAME} or call ${FINISH_RUN_TOOL_NAME} again to end your run now.\n</${FINISH_RUN_REMINDER_TAG}>`
}
