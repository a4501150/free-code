import { createConnection, type Socket } from 'net'
import { readAttachDescriptor } from '../attach/attachDescriptor.js'
import { attachNdjsonReader, writeNdjson } from '../attach/ndjsonConnection.js'
import {
  ATTACH_PROTOCOL_VERSION,
  type AttachEventBody,
  type AttachRequestBody,
  type AttachResponse,
  type WebSessionMeta,
} from '../protocol/attachSchemas.js'

export type AttachClientEvents = {
  onEvent(seq: number, event: AttachEventBody): void
  onClose(reason: string): void
}

export type AttachClient = {
  readonly pid: number
  readonly processNonce: string
  readonly meta: WebSessionMeta
  request(body: AttachRequestBody): Promise<AttachResponse>
  close(): void
}

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Connects to one session process's attach socket.
 *
 * Every permission and ownership check lives in `readAttachDescriptor`, so this
 * refuses to connect to a socket it cannot verify rather than trusting the path.
 */
export async function connectAttachClient(
  pid: number,
  handlers: AttachClientEvents,
): Promise<AttachClient> {
  const descriptor = readAttachDescriptor(pid)
  if (!descriptor.ok) {
    throw new Error(`attach descriptor for pid ${pid}: ${descriptor.reason}`)
  }

  const { socketPath, attachToken, processNonce } = descriptor.descriptor

  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection(socketPath)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })

  let nextRequestId = 1
  const pending = new Map<
    string,
    {
      resolve: (r: AttachResponse) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let closed = false

  function failAllPending(reason: string): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({
        type: 'response',
        requestId: 'closed',
        ok: false,
        error: { code: 'closed', message: reason },
      })
    }
    pending.clear()
  }

  attachNdjsonReader(socket, {
    onLine(line) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      const message = parsed as
        | AttachResponse
        | { type: 'event'; seq: number; event: AttachEventBody }

      if (message.type === 'response') {
        const entry = pending.get(message.requestId)
        if (!entry) return
        pending.delete(message.requestId)
        clearTimeout(entry.timer)
        entry.resolve(message)
        return
      }
      if (message.type === 'event') {
        handlers.onEvent(message.seq, message.event)
      }
    },
    onError(_code, message) {
      failAllPending(message)
    },
    onClose() {
      if (closed) return
      closed = true
      failAllPending('socket closed')
      handlers.onClose('socket closed')
    },
  })

  function request(body: AttachRequestBody): Promise<AttachResponse> {
    if (closed) {
      return Promise.resolve({
        type: 'response',
        requestId: 'closed',
        ok: false,
        error: { code: 'closed', message: 'client is closed' },
      })
    }
    const requestId = String(nextRequestId++)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({
          type: 'response',
          requestId,
          ok: false,
          error: { code: 'timeout', message: 'the session did not answer' },
        })
      }, REQUEST_TIMEOUT_MS)
      pending.set(requestId, { resolve, timer })
      writeNdjson(socket, { type: 'request', requestId, request: body })
    })
  }

  const hello = await request({
    kind: 'hello',
    token: attachToken,
    protocolVersion: ATTACH_PROTOCOL_VERSION,
  })
  if (!hello.ok) {
    socket.destroy()
    throw new Error(
      `attach handshake refused: ${hello.error?.message ?? 'unknown'}`,
    )
  }

  return {
    pid,
    processNonce,
    meta: hello.result as WebSessionMeta,
    request,
    close() {
      closed = true
      failAllPending('client closed')
      socket.destroy()
    },
  }
}
