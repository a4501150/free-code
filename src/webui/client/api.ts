import type {
  AttachEventBody,
  AttachRequestBody,
} from '../protocol/attachSchemas.js'
import type { SessionListEntry } from '../gateway/sessionHub.js'

export type ServerFrame =
  | { type: 'ready'; protocolVersion: number }
  | { type: 'attached'; ok: boolean }
  | { type: 'event'; seq: number; event: AttachEventBody }
  | {
      type: 'response'
      id: string
      ok: boolean
      result?: unknown
      error?: { code: string; message: string }
    }
  | { type: 'error'; code: string; message?: string }

export type LoginResult = 'ok' | 'invalid' | 'throttled' | 'error'

export async function login(password: string): Promise<LoginResult> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (response.ok) return 'ok'
  if (response.status === 401) return 'invalid'
  if (response.status === 429) return 'throttled'
  return 'error'
}

export async function whoAmI(): Promise<{ csrf: string } | null> {
  const response = await fetch('/api/me')
  if (!response.ok) return null
  return (await response.json()) as { csrf: string }
}

export async function fetchSessions(): Promise<SessionListEntry[]> {
  const response = await fetch('/api/sessions')
  if (!response.ok) return []
  const body = (await response.json()) as { sessions: SessionListEntry[] }
  return body.sessions
}

const CSRF_HEADER = 'x-freecode-csrf'

export type CreateResult =
  | { ok: true; pid: number; processKey: string }
  | { ok: false; error: string }

export async function createSession(
  cwd: string,
  csrf: string,
): Promise<CreateResult> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrf },
    body: JSON.stringify({ cwd }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    session?: { pid: number; processKey: string }
    error?: string
  }
  if (response.ok && body.session) {
    return {
      ok: true,
      pid: body.session.pid,
      processKey: body.session.processKey,
    }
  }
  return { ok: false, error: body.error ?? `failed (${response.status})` }
}

export async function stopSession(pid: number, csrf: string): Promise<boolean> {
  const response = await fetch(`/api/sessions/${pid}`, {
    method: 'DELETE',
    headers: { [CSRF_HEADER]: csrf },
  })
  return response.ok
}

export type GatewaySocket = {
  attach(processKey: string): void
  send(body: AttachRequestBody): void
  close(): void
}

/**
 * One websocket for the whole app. Reconnects with backoff, because a phone
 * that locks its screen drops the socket and must recover without a reload.
 */
export function connectGateway(handlers: {
  csrf: string
  onFrame(frame: ServerFrame): void
  onOpen(): void
  onClose(): void
}): GatewaySocket {
  let socket: WebSocket | null = null
  let closedByUs = false
  let attempt = 0
  let currentProcessKey: string | null = null
  let commandId = 0

  function open(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${scheme}://${location.host}/ws`)

    socket.addEventListener('open', () => {
      attempt = 0
      handlers.onOpen()
      // Re-attach after a reconnect so the transcript resumes on its own.
      if (currentProcessKey) attach(currentProcessKey)
    })

    socket.addEventListener('message', event => {
      try {
        handlers.onFrame(JSON.parse(String(event.data)) as ServerFrame)
      } catch {
        // A frame we cannot parse is not worth tearing the socket down for.
      }
    })

    socket.addEventListener('close', () => {
      handlers.onClose()
      if (closedByUs) return
      attempt += 1
      setTimeout(open, Math.min(500 * 2 ** (attempt - 1), 10_000))
    })
  }

  function attach(processKey: string): void {
    currentProcessKey = processKey
    socket?.send(
      JSON.stringify({ type: 'attach', processKey, csrf: handlers.csrf }),
    )
  }

  open()

  return {
    attach,
    send(body) {
      commandId += 1
      socket?.send(
        JSON.stringify({ type: 'command', id: String(commandId), body }),
      )
    },
    close() {
      closedByUs = true
      socket?.close()
    },
  }
}
