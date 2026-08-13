import { readAttachDescriptor } from '../attach/attachDescriptor.js'
import { listLiveSessions } from '../../utils/concurrentSessions.js'
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
  /** How many live processes claim this session ID. Above one needs a choice. */
  holders: number
  state?: string
}

export type HubSubscriber = {
  id: number
  processKey: string
  send(event: { seq: number; event: AttachEventBody }): void
}

type Attachment = {
  client: AttachClient
  processKey: string
  subscribers: Set<HubSubscriber>
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

  function keyFor(pid: number, nonce: string): string {
    return `${pid}:${nonce}`
  }

  async function list(cwd?: string): Promise<SessionListEntry[]> {
    const live = await listLiveSessions()

    const holderCounts = new Map<string, number>()
    for (const entry of live) {
      holderCounts.set(
        entry.sessionId,
        (holderCounts.get(entry.sessionId) ?? 0) + 1,
      )
    }

    const entries: SessionListEntry[] = live.map(entry => {
      const descriptor = readAttachDescriptor(entry.pid)
      const attachable = descriptor.ok
      return {
        processKey: attachable
          ? keyFor(entry.pid, descriptor.descriptor.processNonce)
          : undefined,
        pid: entry.pid,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.name ?? entry.sessionId.slice(0, 8),
        startedAt: entry.startedAt,
        live: true,
        attachable,
        holders: holderCounts.get(entry.sessionId) ?? 1,
      }
    })

    // History. A session with a live process is already listed, so skip it.
    const liveIds = new Set(live.map(entry => entry.sessionId))
    let history: Awaited<ReturnType<typeof listSessionsImpl>> = []
    try {
      history = await listSessionsImpl({ dir: cwd, limit: 100 })
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
          for (const subscriber of current.subscribers) {
            subscriber.send({ seq, event })
          }
        },
        onClose() {
          attachments.delete(processKey)
        },
      })

      // The nonce proves this is the same process the browser was told about,
      // not a different one that recycled the pid.
      if (client.processNonce !== nonce) {
        client.close()
        throw new Error('process identity changed; refresh the session list')
      }

      attachment = { client, processKey, subscribers: new Set() }
      attachments.set(processKey, attachment)
    }

    const subscriber: HubSubscriber = {
      id: nextSubscriberId++,
      processKey,
      send,
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
