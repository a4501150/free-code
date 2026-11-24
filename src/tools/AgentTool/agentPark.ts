// Park-and-wait for subagents that ended a round while still owning running
// background tasks (strict end_turn model — an implicit end is not a
// completion). React-free and dependency-light so runAgent and unit tests
// can import it without pulling ink.

import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import type { TaskState } from '../../tasks/types.js'
import {
  FINISH_RUN_REMINDER_TAG,
  FINISH_RUN_TOOL_NAME,
} from '../FinishRunTool/constants.js'
import {
  isAgentAddressedCommand,
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
export type ParkWake = 'signal' | 'idle' | 'abort'

/**
 * The run's terminal disposition, returned by the runAgent generator (the
 * value a manual `.next()` sees alongside done). Normal ends carry an empty
 * object; a run stopped by the truncated-end backstop carries the truthful
 * errorReason its finalize site must report instead of "completed". Lives
 * here (not runAgent.ts) so agentToolUtils can consume it without an import
 * cycle — runAgent already imports this module.
 */
export type AgentRunOutcome = {
  errorReason?: typeof ENDED_WITHOUT_FINAL_MESSAGE
}

/**
 * Wait until something happens that a parked agent should look at:
 * - 'signal': queued traffic is addressed to this agent (a task
 *   notification, or a prompt queued from its transcript view) or its
 *   pendingMessages grew (SendMessage traffic).
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
      // Same predicate the wake path drains with
      // (isAgentAddressedCommand): waking on a command the drain won't
      // take would burn a model round.
      const hasNotification = someCommand(cmd =>
        isAgentAddressedCommand(cmd, opts.agentId),
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
 * only consecutive no-work FinishRun calls count as the second strike.
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
 * The two run-mechanics reminders (isMeta user messages that ride the
 * conversation, the sidechain transcript and the drill-down — the outbox
 * in runAgent delivers them). Both are wrapped in FINISH_RUN_REMINDER_TAG
 * so the UI renders them as visible reminder rows. Neither is exact-matched
 * by the post-nudge ack skip in finalizeAgentTool (only the legacy
 * FINISH_RUN_REMINDER texts are): a reply to either is a genuine decision
 * — often the final report itself — and must stay deliverable as the
 * result.
 *
 * TEXT A — the run did not end, and nothing is running: the model's turn
 * either carried no text at all (a severed stream or an empty follow-up
 * call) or it woke from a park whose tasks all finished. One action:
 * continue, or report.
 */
export function runNotEndedReminderText(
  reason: 'truncated' | 'tasksFinished',
): string {
  const lines: string[] = []
  if (reason === 'tasksFinished') {
    lines.push('Your background tasks have finished.')
  }
  lines.push(
    reason === 'truncated'
      ? 'Your run has not ended: your last turn was cut off before it delivered anything to your caller.'
      : 'Your run has not ended: your last turn delivered no final report to your caller.',
  )
  lines.push(
    'Continue whatever remains of your work. When it is done, reply with your final report as a plain text message with no tool calls — that ends your run.',
  )
  return `<${FINISH_RUN_REMINDER_TAG}>\n${lines.join('\n')}\n</${FINISH_RUN_REMINDER_TAG}>`
}

/**
 * TEXT B — the run is open with background tasks the agent owns still
 * running. Two options only: wait silently (a no-tool-call end parks the
 * run; task notifications wake it) or finish (report + FinishRun in the
 * SAME message — a report followed by FinishRun across two turns counts as
 * work and gets gated again; the second consecutive no-work FinishRun is
 * honored). The finishRunGated prefix corrects the model that just saw
 * FinishRun's own tool result tell it the run ended: without it, the model
 * believes its run is over and abandons the wait.
 */
export function parkedWithTasksReminderText(
  tasks: TaskState[],
  opts: { finishRunGated?: boolean } = {},
): string {
  const lead = opts.finishRunGated
    ? `Your ${FINISH_RUN_TOOL_NAME} call was not carried out: you still own ${tasks.length} running background task(s), and ending your run kills them.`
    : `You own ${tasks.length} running background task(s):`
  return `<${FINISH_RUN_REMINDER_TAG}>\n${lead}\n${ownedTaskListLines(tasks)}\nTo keep waiting, end your message with no tool calls at all — your run stays alive and their completion notifications wake you. Do not wait by polling, or with no-op commands (echo, true, sleep).\nIf your work is finished, write your final report and call ${FINISH_RUN_TOOL_NAME} in the same message — all background tasks you own will be killed.\n</${FINISH_RUN_REMINDER_TAG}>`
}

/**
 * Whether an implicit end (query() 'completed': the last turn had no tool
 * calls) is a DELIBERATE text-only end and not a truncated/empty stream.
 * terminal.reason and stop_reason cannot tell them apart — providers exist
 * that write stop_reason: null on healthy ends — so the shape of the run's
 * tail decides: the last assistant-or-user message must be an assistant
 * message carrying at least one text block. A user tail (tool result, nudge,
 * resume prompt) or a reasoning-only/tool-only assistant tail means the
 * model never spoke last: the turn was cut off or the follow-up call
 * produced nothing. The live-run analogue of
 * filterOrphanedThinkingOnlyMessages, which already drops thinking-only
 * tails when building a resume seed.
 *
 * Reads the TAIL of the two arrays in order (initialMessages then
 * runMessages — the seeded context followed by the round's own messages),
 * backward, without copying: the gate runs at every round boundary.
 */
export function implicitEndIsDeliberate(
  initialMessages: readonly Message[],
  runMessages: readonly Message[],
): boolean {
  for (const list of [runMessages, initialMessages]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!
      if (m.type !== 'assistant' && m.type !== 'user') continue
      if (m.type !== 'assistant') return false
      return m.message.content.some(block => block.type === 'text')
    }
  }
  return false
}

/**
 * Recovery rounds granted to a run whose implicit end was not deliberate
 * (see implicitEndIsDeliberate) before the truthful backstop ends it. One:
 * a transient stream blip recovers on the nudge, while a deterministic
 * truncation (a provider choking on the very token the model keeps
 * retrying) would burn a round on every nudge.
 */
export const MAX_TRUNCATED_END_NUDGES = 1

/**
 * Truthful stop reason for a run stopped by the truncated-end backstop —
 * nothing its final turn wrote reached the caller as a result. Consumed by
 * finalizeAgentTool (terminalErrorReason) and asserted in the e2e.
 */
export const ENDED_WITHOUT_FINAL_MESSAGE = 'ended_without_final_message'
