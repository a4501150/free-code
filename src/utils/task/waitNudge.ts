/**
 * The blocking-wait nudge for Bash tool results. When a foreground command
 * spent its call blocked in a `sleep` (or a sleep-polling loop, or a
 * `tail -f`), the result footer tells the model HOW to wait instead — end
 * the turn when it owns running background tasks, use the Monitor tool for
 * raw processes/files that have no notification path. BackgroundNudge
 * (backgroundNudge.ts) is the advisory printed at background-launch time;
 * this is the runtime counterpart for when that advice is ignored.
 *
 * Cadence: once per session per kind, scanned from the transcript's stored
 * tool results (per the once-per-window invariant — re-arms after
 * compaction, which is accepted). Repeated reminders that say HOW to wait
 * are still nags: after one nudge per kind the guard stays silent, and a
 * timeout-killed sleep is its own kind because it is the moment the model
 * is most open to changing strategy.
 */

import type { Message } from '../../types/message.js'
import {
  detectBlockingWait,
  isBlockingWait,
  type SleepWaitInfo,
} from '../bash/sleepWait.js'
import { formatDuration } from '../format.js'
import { namedTaskIds } from '../../tasks/ownership.js'
import {
  SHELL_TIMEOUT_EXIT_CODE,
  SHELL_TIMEOUT_OUTPUT_MARKER,
} from '../ShellCommand.js'

export const WAIT_NUDGE_KINDS = [
  'end-turn',
  'monitor',
  'timeout-killed',
] as const

export type WaitNudgeKind = (typeof WAIT_NUDGE_KINDS)[number]

/**
 * Kinds already nudged in this agent's transcript. Reads the structured
 * `waitNudge` field stored on user messages' toolUseResult — a text marker
 * would break under any future wording change. Scans the caller's own
 * message chain, so a subagent starts with its own budget.
 */
export function scanPriorWaitNudges(messages: Message[]): Set<WaitNudgeKind> {
  const kinds = new Set<WaitNudgeKind>()
  for (const message of messages) {
    if (kinds.size === WAIT_NUDGE_KINDS.length) break
    if (message.type !== 'user') continue
    const result = message.toolUseResult
    if (
      typeof result === 'object' &&
      result !== null &&
      'waitNudge' in result &&
      typeof (result as { waitNudge?: unknown }).waitNudge === 'string' &&
      WAIT_NUDGE_KINDS.includes(
        (result as { waitNudge: WaitNudgeKind }).waitNudge,
      )
    ) {
      kinds.add((result as { waitNudge: WaitNudgeKind }).waitNudge)
    }
  }
  return kinds
}

function describeWait(info: SleepWaitInfo): string {
  if (info.inLoop) return 'in a `sleep`-polling loop'
  if (info.follow)
    return 'in a foreground `tail -f` (it never exits on its own)'
  const seconds = info.topSleepSeconds ?? 0
  return `for ${formatDuration(seconds * 1000)} in \`sleep\``
}

function endTurnAdvice(taskIds: string[]): string {
  const named = taskIds.length > 0 ? ` (${namedTaskIds(taskIds)})` : ''
  return `End your turn${taskIds.length > 0 ? ` — your running background task${taskIds.length > 1 ? 's' : ''}${named} will notify you on completion` : ''}, and no sleep or poll makes a notification arrive sooner. If you have other work, do that instead.`
}

function monitorAdvice(monitorAvailable: boolean): string {
  return monitorAvailable
    ? 'Nothing you launched yourself has a notification path — to wait on a file or process, use the Monitor tool (it runs detached and notifies when the output changes) instead of a foreground sleep.'
    : 'To wait on something, use a single bounded wait with an explicit `timeout` parameter that covers it, or end the turn and ask the user how long to wait.'
}

/**
 * Decide whether a completed foreground Bash result carries a wait nudge.
 * Pure — every input is call-site data, so the whole policy is unit-testable.
 * Returns null when the command held no blocking wait, was backgrounded or
 * interactive, or the kind was already nudged this transcript.
 * `priorKinds` is a thunk so the transcript scan runs only after a blocking
 * wait was actually detected.
 */
export function decideWaitNudge(input: {
  command: string
  /** Merged stdout+stderr as delivered in the result. */
  output: string
  exitCode: number | undefined
  timeoutMs: number
  /** IDs of the caller's own running background tasks (agent-scoped). */
  ownRunningTaskIds: string[]
  monitorAvailable: boolean
  priorKinds: () => Set<WaitNudgeKind>
}): { kind: WaitNudgeKind; text: string } | null {
  const info = detectBlockingWait(input.command)
  if (info === null || !isBlockingWait(info)) return null

  const timedOut =
    input.exitCode === SHELL_TIMEOUT_EXIT_CODE &&
    input.output.includes(SHELL_TIMEOUT_OUTPUT_MARKER)

  const kind: WaitNudgeKind = timedOut
    ? 'timeout-killed'
    : input.ownRunningTaskIds.length > 0
      ? 'end-turn'
      : 'monitor'
  if (input.priorKinds().has(kind)) return null

  const wait = describeWait(info)
  if (timedOut) {
    const lead = `The command was killed by the Bash timeout (${formatDuration(input.timeoutMs)})${info.inLoop ? ' while running a `sleep`-polling loop' : ' before the `sleep` finished'} — a foreground wait cannot succeed under a timeout it outlasts. `
    return {
      kind,
      text:
        lead +
        (input.ownRunningTaskIds.length > 0
          ? endTurnAdvice(input.ownRunningTaskIds)
          : monitorAdvice(input.monitorAvailable)),
    }
  }
  if (kind === 'end-turn') {
    return {
      kind,
      text: `This call blocked the tool loop ${wait}. You still own running background tasks. ${endTurnAdvice(input.ownRunningTaskIds)}`,
    }
  }
  return {
    kind,
    text: `This call blocked the tool loop ${wait}. ${monitorAdvice(input.monitorAvailable)}`,
  }
}
