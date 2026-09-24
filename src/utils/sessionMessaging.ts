import { randomUUID } from 'crypto'
import { connectAttachClient } from '../webui/gateway/attachClient.js'
import { listLiveSessions } from './concurrentSessions.js'

export type SessionDelivery = { ok: boolean; error?: string }

/**
 * Deliver a message to another live session as a prompt turn.
 *
 * Addressing rides the session registry (concurrentSessions) plus the target
 * process's attach socket — the same submit channel the webui uses. A session
 * whose process exposes no attach descriptor (a standalone TUI without the
 * webui, or a holder owned by another user) is reported as not addressable;
 * registry liveness checks fail open, so a just-exited session can also show
 * up here momentarily.
 */
export async function deliverToSession(
  sessionId: string,
  text: string,
): Promise<SessionDelivery> {
  const live = await listLiveSessions()
  const entry = live.find(
    s => s.sessionId === sessionId && s.pid !== process.pid,
  )
  if (!entry) {
    return {
      ok: false,
      error: `No live session ${sessionId} in the session registry. List targets with ListAgents.`,
    }
  }

  let client: Awaited<ReturnType<typeof connectAttachClient>> | null = null
  try {
    client = await connectAttachClient(entry.pid, {
      onEvent: () => {},
      onClose: () => {},
    })
    const response = await client.request({
      kind: 'submit',
      commandId: `peer-msg-${randomUUID()}`,
      content: text,
      delivery: 'next',
      sessionEpoch: client.meta.sessionEpoch,
    })
    if (!response.ok) {
      return {
        ok: false,
        error: `Session ${sessionId} rejected the message: ${response.error?.message ?? 'submit failed'}`,
      }
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: `Session ${sessionId} (pid ${entry.pid}) is not addressable over its attach socket: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    client?.close()
  }
}
