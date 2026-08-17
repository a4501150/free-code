import { readAttachDescriptor } from '../attach/attachDescriptor.js'
import {
  listLiveSessions,
  type ConcurrentSessionEntry,
} from '../../utils/concurrentSessions.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import type {
  AttachEventBody,
  AttachRequestBody,
  AttachResponse,
} from '../protocol/attachSchemas.js'
import { connectAttachClient, type AttachClient } from './attachClient.js'

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
  /** True when the gateway spawned a process in this row, so it may stop it. */
  owned: boolean
  /** The gateway-spawned process `owned` refers to. */
  stoppablePid?: number
  /** How many live processes claim this session ID. Above one needs a choice. */
  holders: number
  state?: string
}

export type HubSubscriber = {
  id: number
  processKey: string
  send(event: { seq: number; event: AttachEventBody }): void
  /**
   * The process behind this subscription ended. Without this a browser keeps a
   * dead transcript and every later command answers `not_attached`.
   */
  onGone(info: { processKey: string; sessionId: string; reason: string }): void
}

type Attachment = {
  client: AttachClient
  processKey: string
  subscribers: Set<HubSubscriber>
  /** The session the process reports now, which a switch can change. */
  sessionId: string
}

/** A live process, paired with what the gateway could verify about it. */
export type LiveHolder = {
  entry: ConcurrentSessionEntry
  /** The process nonce, present only when its descriptor could be trusted. */
  nonce?: string
  /** True when this gateway spawned the process. */
  owned: boolean
}

function keyFor(pid: number, nonce: string): string {
  return `${pid}:${nonce}`
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

/**
 * One row for each session, not for each live process.
 *
 * Two processes can hold one session ID, because a terminal resume offers to
 * adopt a session another window already has. Listing both produced a duplicate
 * row for one conversation, so the group elects a primary and reports the rest
 * through `holders`. `stoppablePid` stays separate from the primary, or a stuck
 * gateway child would become unreachable whenever a terminal outranked it.
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
        ? keyFor(primary.entry.pid, primary.nonce)
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

/**
 * Owns the gateway's view of sessions.
 *
 * Discovery merges three sources: the PID registry for liveness, attach
 * descriptors for controllability, and the transcript directory for history.
 * The registry is read-only and fails open by design, so this keeps its own
 * table of what it actually holds open.
 */
export function createSessionHub() {
  const attachments = new Map<string, Attachment>()
  let nextSubscriberId = 1

  async function list(
    options: { cwd?: string; owns?: (pid: number) => boolean } = {},
  ): Promise<SessionListEntry[]> {
    const live = await listLiveSessions()

    const holders: LiveHolder[] = live.map(entry => {
      const descriptor = readAttachDescriptor(entry.pid)
      // A session switch rewrites the descriptor asynchronously, so it can name
      // another session for a moment. Attaching then opens the wrong transcript.
      const agrees =
        descriptor.ok && descriptor.descriptor.sessionId === entry.sessionId
      return {
        entry,
        nonce: agrees ? descriptor.descriptor.processNonce : undefined,
        owned: options.owns?.(entry.pid) ?? false,
      }
    })

    const entries = groupLiveHolders(holders)

    // History. A session with a live process is already listed, so skip it.
    const liveIds = new Set(live.map(entry => entry.sessionId))
    let history: Awaited<ReturnType<typeof listSessionsImpl>> = []
    try {
      history = await listSessionsImpl({ dir: options.cwd, limit: 100 })
    } catch {
      history = []
    }

    for (const info of history) {
      if (liveIds.has(info.sessionId)) continue
      entries.push({
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

    return entries
  }

  /**
   * Opens or reuses the attachment for a process, then registers a subscriber.
   * One socket per process regardless of how many browsers watch it.
   */
  async function subscribe(
    processKey: string,
    send: HubSubscriber['send'],
    onGone: HubSubscriber['onGone'],
  ): Promise<{ subscriber: HubSubscriber; attachment: Attachment }> {
    const [pidText, nonce] = processKey.split(':')
    const pid = Number(pidText)
    if (!Number.isInteger(pid) || pid <= 0 || !nonce) {
      throw new Error('malformed process key')
    }

    let attachment = attachments.get(processKey)
    if (!attachment) {
      const client = await connectAttachClient(pid, {
        onEvent(seq, event) {
          const current = attachments.get(processKey)
          if (!current) return
          // `/resume` and `/clear` both change the session a process serves, so
          // the ID from the hello handshake goes stale. Followers need the one
          // it serves now.
          if (event.kind === 'session_changed') {
            current.sessionId = event.sessionId
          } else if (event.kind === 'snapshot') {
            current.sessionId = event.meta.sessionId
          }
          for (const subscriber of current.subscribers) {
            subscriber.send({ seq, event })
          }
        },
        onClose(reason) {
          const current = attachments.get(processKey)
          if (!current) return
          attachments.delete(processKey)
          // Notify from the retained set, and empty it, so a later unsubscribe
          // cannot deliver this twice.
          const gone = [...current.subscribers]
          current.subscribers.clear()
          for (const subscriber of gone) {
            subscriber.onGone({
              processKey,
              sessionId: current.sessionId,
              reason,
            })
          }
        },
      })

      // The nonce proves this is the same process the browser was told about,
      // not a different one that recycled the pid.
      if (client.processNonce !== nonce) {
        client.close()
        throw new Error('process identity changed; refresh the session list')
      }

      attachment = {
        client,
        processKey,
        subscribers: new Set(),
        sessionId: client.meta.sessionId,
      }
      attachments.set(processKey, attachment)
    }

    const subscriber: HubSubscriber = {
      id: nextSubscriberId++,
      processKey,
      send,
      onGone,
    }
    attachment.subscribers.add(subscriber)
    return { subscriber, attachment }
  }

  function unsubscribe(subscriber: HubSubscriber): void {
    const attachment = attachments.get(subscriber.processKey)
    if (!attachment) return
    attachment.subscribers.delete(subscriber)
    // Keep the socket open briefly? No: reconnecting is cheap and an idle
    // socket in every watched process is not free. The snapshot on re-subscribe
    // is authoritative anyway.
    if (attachment.subscribers.size === 0) {
      attachment.client.close()
      attachments.delete(subscriber.processKey)
    }
  }

  async function request(
    processKey: string,
    body: AttachRequestBody,
  ): Promise<AttachResponse> {
    const attachment = attachments.get(processKey)
    if (!attachment) {
      return {
        type: 'response',
        requestId: 'none',
        ok: false,
        error: {
          code: 'not_attached',
          message: 'not attached to that session',
        },
      }
    }
    return attachment.client.request(body)
  }

  function stop(): void {
    for (const attachment of attachments.values()) {
      attachment.client.close()
    }
    attachments.clear()
  }

  return { list, subscribe, unsubscribe, request, stop }
}

export type SessionHub = ReturnType<typeof createSessionHub>
