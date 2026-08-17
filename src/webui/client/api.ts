import type {
  AttachEventBody,
  AttachRequestBody,
} from '../protocol/attachSchemas.js'
import type { SessionListEntry } from '../gateway/sessionHub.js'
import type { DirectoryListing } from '../gateway/directories.js'

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

export type DirectoryResult =
  | { ok: true; listing: DirectoryListing }
  | { ok: false; error: string }

/**
 * Asks the host what a partial path could continue into. A trailing separator
 * means the contents of that directory; anything else filters its parent.
 */
export async function fetchDirectories(
  path: string,
  showHidden: boolean,
  signal: AbortSignal,
): Promise<DirectoryResult> {
  const query = new URLSearchParams({ path, hidden: showHidden ? '1' : '0' })
  const response = await fetch(`/api/directories?${query}`, { signal })
  if (!response.ok) return { ok: false, error: await readError(response) }
  return { ok: true, listing: (await response.json()) as DirectoryListing }
}

const CSRF_HEADER = 'x-freecode-csrf'

/**
 * The gateway answers with a short code. Turn it into something a person can
 * act on, because the browser is often the only surface a phone user has.
 */
const ERROR_TEXT: Record<string, string> = {
  bad_csrf: 'The login expired. Reload the page.',
  bad_path: 'That path cannot be read.',
  bad_session_id: 'That session ID is not valid.',
  cwd_not_absolute: 'Enter a path that starts at the root, such as /Users.',
  cwd_not_directory: 'That path is a file, not a directory.',
  cwd_not_found: 'There is no such directory on the host.',
  cwd_not_local: 'A network path cannot be a working directory.',
  cwd_required: 'Enter a working directory.',
  cwd_unreadable: 'The host cannot read that directory.',
  directory_not_found: 'There is no such directory on the host.',
  directory_not_readable: 'The host cannot read that directory.',
  not_owned: 'This gateway did not start that session.',
  path_not_absolute: 'Enter a path that starts at the root, such as /Users.',
  path_not_directory: 'That path is a file, not a directory.',
  path_not_local: 'A network path cannot be browsed.',
  session_has_no_cwd: 'That session has no recorded directory.',
  session_in_use: 'That session is already running.',
  unauthorized: 'The login expired. Reload the page.',
  unknown_session: 'That session is no longer in the history.',
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  const code = body.error ?? ''
  // `??` would not help here: an absent code is already the empty string.
  return ERROR_TEXT[code] || code || `failed (${response.status})`
}

/** Start a fresh session, or revive one from the history. */
export type StartRequest = { cwd: string } | { resumeSessionId: string }

export type StartResult =
  | { ok: true; pid: number; processKey: string; sessionId: string }
  | { ok: false; error: string }

export async function startSession(
  request: StartRequest,
  csrf: string,
): Promise<StartResult> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrf },
    body: JSON.stringify(request),
  })
  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      session?: { pid: number; processKey: string; sessionId: string }
    }
    if (body.session) return { ok: true, ...body.session }
  }
  return { ok: false, error: await readError(response) }
}

export type StopResult = { ok: true } | { ok: false; error: string }

export async function stopSession(
  pid: number,
  csrf: string,
): Promise<StopResult> {
  const response = await fetch(`/api/sessions/${pid}`, {
    method: 'DELETE',
    headers: { [CSRF_HEADER]: csrf },
  })
  if (response.ok) return { ok: true }
  return { ok: false, error: await readError(response) }
}

/** What a command answered. `ok` false carries the gateway's short code. */
export type CommandResult = {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type GatewaySocket = {
  attach(processKey: string): void
  send(body: AttachRequestBody): void
  /** Send and wait for the answer. Rejects if the socket closes first. */
  request(body: AttachRequestBody): Promise<CommandResult>
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
  const pending = new Map<string, (result: CommandResult) => void>()
  const rejecters = new Map<string, (error: Error) => void>()

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
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame
      } catch {
        // A frame we cannot parse is not worth tearing the socket down for.
        return
      }
      if (frame.type === 'response') {
        const settle = pending.get(frame.id)
        pending.delete(frame.id)
        rejecters.delete(frame.id)
        settle?.({ ok: frame.ok, result: frame.result, error: frame.error })
      }
      handlers.onFrame(frame)
    })

    socket.addEventListener('close', () => {
      handlers.onClose()
      // A pending answer can never arrive on a dead socket, and a caller
      // awaiting one would hang forever.
      for (const reject of rejecters.values()) {
        reject(new Error('the connection dropped'))
      }
      pending.clear()
      rejecters.clear()
      if (closedByUs) return
      attempt += 1
      setTimeout(open, Math.min(500 * 2 ** (attempt - 1), 10_000))
    })
  }

  function attach(processKey: string): void {
    currentProcessKey = processKey
    // A send on a CONNECTING socket is dropped, not queued. Recording the key is
    // enough, because the open handler re-attaches to it.
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(
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
    request(body) {
      commandId += 1
      const id = String(commandId)
      return new Promise<CommandResult>((resolve, reject) => {
        if (socket?.readyState !== WebSocket.OPEN) {
          reject(new Error('not connected'))
          return
        }
        pending.set(id, resolve)
        rejecters.set(id, reject)
        socket.send(JSON.stringify({ type: 'command', id, body }))
      })
    },
    close() {
      closedByUs = true
      socket?.close()
    },
  }
}
