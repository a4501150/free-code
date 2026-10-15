/**
 * The session-list row and the one-row-per-session grouping rule.
 *
 * Extracted from the gateway's session hub when sessiond took over session
 * ownership: the hub's live/descriptor/history merge now lives in
 * `registry.ts`, but the ROW is part of the browser contract (the client
 * renders it) and the grouping is pure policy, so both live here where
 * server and client can import them without pulling any server machinery.
 */

import type { ConcurrentSessionEntry } from '../utils/concurrentSessions.js'

export type SessionListEntry = {
  /** Stable per live process. Absent for a historical session. */
  processKey?: string
  pid?: number
  sessionId: string
  cwd?: string
  gitBranch?: string
  title: string
  startedAt?: number
  lastModified?: number
  live: boolean
  attachable: boolean
  /** True when this serve hosts the row, so it may stop it. */
  owned: boolean
  /** The stoppable process behind an `owned` row. */
  stoppablePid?: number
  /** How many live processes claim this session ID. Above one needs a choice. */
  holders: number
  state?: string
  /**
   * The serve-hosted assistant chat. Stamped by the serve process on its own
   * assistant row; the browser opens that session as the main chat.
   */
  role?: 'assistant'
}

/** A live process, paired with what the server could verify about it. */
export type LiveHolder = {
  entry: ConcurrentSessionEntry
  /** The process nonce, present only when its descriptor could be trusted. */
  nonce?: string
  /** True when this serve hosts the process. */
  owned: boolean
}

/**
 * One row for each session, not for each live process.
 *
 * Two processes can hold one session ID, because a terminal resume offers to
 * adopt a session another window already has. Listing both produced a duplicate
 * row for one conversation, so the group elects a primary and reports the rest
 * through `holders`. `stoppablePid` stays separate from the primary, or a stuck
 * hosted child would become unreachable whenever a terminal outranked it.
 */
export function groupLiveHolders(
  holders: readonly LiveHolder[],
): SessionListEntry[] {
  const bySession = new Map<string, LiveHolder[]>()
  for (const holder of holders) {
    const group = bySession.get(holder.entry.sessionId)
    if (group) group.push(holder)
    else bySession.set(holder.entry.sessionId, [holder])
  }

  const rows: SessionListEntry[] = []
  for (const group of bySession.values()) {
    const primary = [...group].sort(compareHolders)[0]!
    const stoppable = group.find(holder => holder.owned)
    rows.push({
      processKey: primary.nonce
        ? `${primary.entry.pid}:${primary.nonce}`
        : undefined,
      pid: primary.entry.pid,
      sessionId: primary.entry.sessionId,
      cwd: primary.entry.cwd,
      title: primary.entry.name ?? primary.entry.sessionId.slice(0, 8),
      startedAt: primary.entry.startedAt,
      live: true,
      attachable: primary.nonce !== undefined,
      owned: stoppable !== undefined,
      stoppablePid: stoppable?.entry.pid,
      holders: group.length,
    })
  }

  return rows.sort((a, b) => a.startedAt! - b.startedAt! || a.pid! - b.pid!)
}

function compareHolders(a: LiveHolder, b: LiveHolder): number {
  // A process nobody can attach to is a poor representative for the session.
  if ((a.nonce === undefined) !== (b.nonce === undefined)) {
    return a.nonce === undefined ? 1 : -1
  }
  // A terminal outranks a web viewer, because a person is sitting at it.
  const aWorker = a.entry.kind === 'daemon-worker'
  const bWorker = b.entry.kind === 'daemon-worker'
  if (aWorker !== bWorker) return aWorker ? 1 : -1
  return b.entry.startedAt - a.entry.startedAt || a.entry.pid - b.entry.pid
}
