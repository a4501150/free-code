/**
 * The sessions one serve process knows about.
 *
 * Two kinds of row, one table. Hosted rows are `HostedSession`s running in
 * this process; their channel answers directly and their processKey is
 * `<serve pid>:<per-session nonce>` — the same shape the browser already
 * speaks for a spawned child, so the client treats keys as opaque.
 * Everything else (a terminal TUI, a headless child) is discovered the way
 * the gateway discovered it: the PID registry for liveness, an attach
 * descriptor for controllability, and the transcript directory for history.
 */

import { randomUUID } from 'crypto'
import { createHostedSession, type HostedSession } from './hosted.js'
import { groupLiveHolders, type SessionListEntry } from './sessionList.js'
import { readAttachDescriptor } from '../server/descriptor.js'
import {
  listLiveSessions,
  type ConcurrentSessionEntry,
} from '../utils/concurrentSessions.js'
import { listSessionsImpl } from '../utils/listSessionsImpl.js'
import { validateSessionCwd, PathError } from '../webui/gateway/directories.js'
import { validateUuid } from '../utils/uuid.js'
import {
  loadMessagesFromJsonlPath,
  deserializeMessages,
} from '../utils/conversationRecovery.js'
import { join } from 'path'
import { getProjectDir } from '../utils/sessionStorage.js'
import { canonicalizePath } from '../utils/sessionStoragePortable.js'
import type { Message } from '../types/message.js'
import type { Command } from '../commands.js'
import type { Tool, ToolPermissionContext } from '../Tool.js'
import type { WirePermissionMode } from '../session/wire.js'
import { assembleSessionDefaults } from './sessionDefaults.js'

export type HostedEntry = {
  /** `<serve pid>:<nonce>` — the browser's handle for this session. */
  processKey: string
  nonce: string
  sessionId: string
  cwd: string
  startedAt: number
  role?: 'assistant'
  hosted: HostedSession
}

export type SessionDefaults = {
  permissionMode?: WirePermissionMode
  /**
   * The full context assembled by `assembleSessionDefaults` (rules from
   * disk + inherited CLI flags). Seeded into the session's store, so the
   * session's permission decisions see the same rules the spawned child
   * would have loaded.
   */
  toolPermissionContext?: ToolPermissionContext
  commands?: Command[]
  tools?: Tool[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /**
   * Inherited `web start --allowed-tools` / `--disallowed-tools`, read by
   * `assembleSessionDefaults` when the pool is assembled here. (The
   * `settings`/`settingSources` flags have no hosted channel yet.)
   */
  allowedTools?: string[]
  disallowedTools?: string[]
}

export type SessionRegistry = {
  /** Start a fresh hosted session in `cwd`. PathErrors surface as thrown. */
  create(options: {
    cwd: string
    role?: 'assistant'
    defaults?: SessionDefaults
  }): Promise<HostedEntry>
  /**
   * Resume a historical session as a hosted one: the caller has already
   * resolved and validated the working directory (the row's, never the
   * client's).
   */
  resume(options: {
    sessionId: string
    cwd: string
    role?: 'assistant'
    defaults?: SessionDefaults
  }): Promise<HostedEntry>
  stop(processKey: string): boolean
  stopAll(): void
  get(processKey: string): HostedEntry | undefined
  bySessionId(sessionId: string): HostedEntry | undefined
  /**
   * The session ids currently hosted, read from the live channels so a
   * `/clear` rotation shows up immediately. Feeds the serve descriptor's
   * `sessionIds` and the tokened `/v1/sessions` listing.
   */
  hostedSessionIds(): string[]
  /** The hosted rows themselves; external rows have none. */
  hostedEntries(): readonly HostedEntry[]
  /**
   * The merged session list: hosted rows + external live rows + history.
   * `q` filters the HISTORY rows by title/cwd substring; live rows always
   * come through — a search must never hide the session you are in.
   */
  list(options?: { q?: string }): Promise<SessionListEntry[]>
}

/** What a `q` search answers with; deep enough to scroll, light enough to poll. */
const SEARCH_HISTORY_LIMIT = 50

/**
 * `onChanged` fires after the hosted set changes (create, resume, stop),
 * which is what makes serve re-publish its descriptor's `sessionIds`.
 */
export function createSessionRegistry(onChanged?: () => void): SessionRegistry {
  const hosted = new Map<string, HostedEntry>()

  async function start(
    cwd: string,
    sessionId: string,
    initialTranscript: Message[] | undefined,
    role: 'assistant' | undefined,
    defaults: SessionDefaults | undefined,
  ): Promise<HostedEntry> {
    // Before anything: a bare ENOENT from the session core is not advice a
    // browser can act on, and every caller gets the check this way.
    await validateSessionCwd(cwd)
    // Realpath the way a spawned child's process.cwd() would have: the
    // transcript, the history row and a terminal --resume all derive the
    // project directory from this string, and a symlinked path (/var vs
    // /private/var) would split the session across two project dirs.
    cwd = await canonicalizePath(cwd)
    // A caller that assembled its own pool (a test, a bespoke host) wins;
    // everyone else gets the core-construction counterpart of the CLI
    // flags the old gateway passed to its spawned child.
    const full =
      defaults?.commands && defaults.tools
        ? defaults
        : await assembleSessionDefaults(cwd, defaults)
    const session = createHostedSession({
      sessionId,
      cwd,
      initialTranscript,
      commands: full.commands,
      tools: full.tools,
      toolPermissionContext: full.toolPermissionContext,
      permissionMode: full.permissionMode,
      customSystemPrompt: full.customSystemPrompt,
      appendSystemPrompt: full.appendSystemPrompt,
    })
    const entry: HostedEntry = {
      processKey: `${process.pid}:${randomUUID()}`,
      nonce: '',
      sessionId,
      cwd,
      startedAt: Date.now(),
      role,
      hosted: session,
    }
    entry.nonce = entry.processKey.split(':')[1]!
    hosted.set(entry.processKey, entry)
    onChanged?.()
    return entry
  }

  return {
    create({ cwd, role, defaults }) {
      return start(cwd, randomUUID(), undefined, role, defaults)
    },

    async resume({ sessionId, cwd, role, defaults }) {
      // The pure chain-walk load: main-conversation messages only. Titles,
      // sidechain files and file-history snapshots ride the transcript for a
      // later resume surface; the model only needs the chain.
      //
      // The path comes from the ROW's cwd, resolved here rather than through
      // getTranscriptPathForSession: the request context has no session
      // scope, so that helper would guess from the serve process's own cwd
      // and miss a hosted session that was recorded under its own directory.
      const { messages } = await loadMessagesFromJsonlPath(
        join(getProjectDir(cwd), `${sessionId}.jsonl`),
      )
      return start(
        cwd,
        sessionId,
        deserializeMessages(messages as Message[]),
        role,
        defaults,
      )
    },

    stop(processKey) {
      const entry = hosted.get(processKey)
      if (!entry) return false
      hosted.delete(processKey)
      entry.hosted.stop()
      return true
    },

    stopAll() {
      for (const key of [...hosted.keys()]) this.stop(key)
    },

    get(processKey) {
      return hosted.get(processKey)
    },

    bySessionId(sessionId) {
      for (const entry of hosted.values()) {
        if (
          entry.sessionId === sessionId ||
          entry.hosted.channel.sessionId === sessionId
        )
          return entry
      }
      return undefined
    },

    hostedSessionIds() {
      return [...hosted.values()].map(entry => entry.hosted.channel.sessionId)
    },

    hostedEntries() {
      return [...hosted.values()]
    },

    async list(options?: { q?: string }) {
      const q = options?.q?.trim().toLowerCase()
      const hostedEntries: SessionListEntry[] = [...hosted.values()].map(
        entry => ({
          processKey: entry.processKey,
          pid: process.pid,
          sessionId: entry.hosted.channel.sessionId,
          cwd: entry.cwd,
          title: entry.hosted.channel.sessionId.slice(0, 8),
          startedAt: entry.startedAt,
          live: true,
          attachable: true,
          owned: true,
          stoppablePid: process.pid,
          holders: 1,
        }),
      )

      // External live rows: a terminal session the browser may attach to,
      // proxied to its own surface. The serve process hosts none of these,
      // so none are owned.
      const live = await listLiveSessions()
      const externalHolders: {
        entry: ConcurrentSessionEntry
        nonce?: string
        owned: false
      }[] = live.map(
        (
          entry,
        ): {
          entry: ConcurrentSessionEntry
          nonce?: string
          owned: false
        } => {
          const descriptor = readAttachDescriptor(entry.pid)
          const agrees =
            descriptor.ok && descriptor.descriptor.sessionId === entry.sessionId
          return {
            entry,
            nonce: agrees ? descriptor.descriptor.processNonce : undefined,
            owned: false,
          }
        },
      )
      // Chronological, like the old hub: hosted rows first unsorted would
      // shadow an earlier-started terminal row when a client picks "the
      // first live row".
      const rows = [...hostedEntries, ...groupLiveHolders(externalHolders)]
      rows.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))

      // History, skipping anything already live (hosted or external).
      const liveIds = new Set<string>([
        ...live.map(entry => entry.sessionId),
        ...[...hosted.values()].map(e => e.hosted.channel.sessionId),
      ])
      let history: Awaited<ReturnType<typeof listSessionsImpl>> = []
      try {
        history = await listSessionsImpl({ limit: 100 })
      } catch {
        history = []
      }
      // A search answers the history only: every live row survives the
      // filter, and the searched fields are exactly the ones a row shows —
      // a miss on unseen text is a row the user could not have typed for.
      const historyRows = history
        .filter(info => !liveIds.has(info.sessionId))
        .filter(info => {
          if (!q) return true
          const title = (
            info.summary || info.sessionId.slice(0, 8)
          ).toLowerCase()
          return (
            title.includes(q) ||
            (info.cwd ?? '').toLowerCase().includes(q) ||
            (info.gitBranch ?? '').toLowerCase().includes(q)
          )
        })
        .slice(0, q ? SEARCH_HISTORY_LIMIT : 100)
      for (const info of historyRows) {
        rows.push({
          sessionId: info.sessionId,
          cwd: info.cwd,
          gitBranch: info.gitBranch,
          title: info.summary || info.sessionId.slice(0, 8),
          lastModified: info.lastModified,
          live: false,
          attachable: false,
          owned: false,
          holders: 0,
        })
      }
      return rows
    },
  }
}

export { PathError, validateUuid }
