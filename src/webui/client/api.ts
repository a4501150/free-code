import type {
  WireCommand,
  WireEvent,
  WireEventEnvelope,
  WireImagePayload,
  WireTranscriptSnapshot,
} from '../../session/wire.js'
import type { SessionListEntry } from '../../sessiond/sessionList.js'
import type { DirectoryListing } from '../gateway/directories.js'

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

export async function fetchSessions(q?: string): Promise<SessionListEntry[]> {
  const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
  const response = await fetch(`/api/sessions${query}`)
  if (!response.ok) return []
  const body = (await response.json()) as { sessions: SessionListEntry[] }
  return body.sessions
}

/**
 * One agent's sidechain transcript, or null when the session cannot serve it
 * (no such agent, or a host that predates the drill-down route).
 */
export async function fetchAgentTranscript(
  processKey: string,
  agentId: string,
): Promise<WireTranscriptSnapshot | null> {
  const response = await fetch(
    `/api/sessions/${processKey}/agents/${encodeURIComponent(agentId)}/transcript`,
  ).catch(() => null)
  if (!response?.ok) return null
  const body = (await response
    .json()
    .catch((): null => null)) as WireTranscriptSnapshot | null
  return body && Array.isArray(body.items) && Array.isArray(body.order)
    ? body
    : null
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
  no_such_agent: 'That agent has no transcript here (yet).',
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

/**
 * Replace the gateway daemon, which is how a rebuilt binary takes effect.
 *
 * Every gateway-owned session dies with it, this browser's included, and the
 * socket drops. The reconnect is automatic once the replacement binds, provided
 * the tunnel gives back the same hostname.
 */
export async function restartGateway(csrf: string): Promise<StopResult> {
  const response = await fetch('/api/restart', {
    method: 'POST',
    headers: { [CSRF_HEADER]: csrf },
  })
  if (response.ok) return { ok: true }
  return { ok: false, error: await readError(response) }
}

export async function logout(csrf: string): Promise<void> {
  await fetch('/api/logout', {
    method: 'POST',
    headers: { [CSRF_HEADER]: csrf },
  })
}

/** What a command answered. `ok` false carries the route's short code. */
export type CommandResult = {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

/** The command routes under `/api/sessions/<processKey>/`. */
export type SessionCommandRoute =
  | 'prompt'
  | 'cancel'
  | 'request_respond'
  | 'model'
  | 'mode'
  | 'rpc'

/**
 * The one gateway websocket. It carries gateway-level frames only —
 * `ready` and `restart_ready`; session traffic is HTTP plus SSE.
 */
export type GatewayInfoSocket = {
  close(): void
}

export function connectGatewayInfo(handlers: {
  onOpen(): void
  onClose(): void
  onRestartReady(info: {
    publicUrl: string | null
    localUrl: string | null
  }): void
}): GatewayInfoSocket {
  let socket: WebSocket | null = null
  let closedByUs = false
  let attempt = 0

  function open(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${scheme}://${location.host}/ws`)

    socket.addEventListener('open', () => {
      attempt = 0
      handlers.onOpen()
    })

    socket.addEventListener('message', event => {
      let frame: { type?: string } & Record<string, unknown>
      try {
        frame = JSON.parse(String(event.data)) as typeof frame
      } catch {
        // A frame we cannot parse is not worth tearing the socket down for.
        return
      }
      if (frame.type === 'restart_ready') {
        handlers.onRestartReady({
          publicUrl: (frame.publicUrl as string | null) ?? null,
          localUrl: (frame.localUrl as string | null) ?? null,
        })
      }
    })

    socket.addEventListener('close', () => {
      handlers.onClose()
      if (closedByUs) return
      attempt += 1
      setTimeout(open, Math.min(500 * 2 ** (attempt - 1), 10_000))
    })
  }

  open()

  return {
    close() {
      closedByUs = true
      socket?.close()
    },
  }
}

export type SessionStream = {
  close(): void
}

/**
 * The session event stream. `EventSource` replays with `Last-Event-ID` on its
 * own, because the SSE frames carry `id:`.
 */
export function connectSessionStream(
  processKey: string,
  handlers: {
    onEvent(seq: number, event: WireEvent): void
    /**
     * The stream will not recover on its own: the server answered the (re)connect
     * with a non-ok status, so the process behind the key is gone or the session
     * was never there.
     */
    onOffline(): void
  },
): SessionStream {
  const source = new EventSource(`/api/sessions/${processKey}/events`)

  source.addEventListener('message', event => {
    let envelope: WireEventEnvelope
    try {
      envelope = JSON.parse(
        String((event as MessageEvent).data),
      ) as WireEventEnvelope
    } catch {
      return
    }
    if (typeof envelope?.seq !== 'number' || !envelope.event) return
    handlers.onEvent(envelope.seq, envelope.event)
  })

  source.addEventListener('error', () => {
    // `CLOSED` on an error means the server answered non-ok: a retry would
    // answer the same way. Anything else, the browser retries by itself.
    if (source.readyState === EventSource.CLOSED) handlers.onOffline()
  })

  return { close: () => source.close() }
}

/**
 * POSTs one command to the attached session's route.
 *
 * The answer is `{ok:true,result?}` or `{ok:false,error:{code,message}}`; a
 * 409 (`stale_epoch`, `interaction_not_pending`) is an ordinary answer, not a
 * transport failure.
 */
export async function sendCommand(
  processKey: string,
  csrf: string,
  route: SessionCommandRoute,
  command: WireCommand,
): Promise<CommandResult> {
  let response: Response
  try {
    response = await fetch(`/api/sessions/${processKey}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrf },
      body: JSON.stringify(command),
    })
  } catch {
    return {
      ok: false,
      error: { code: 'unreachable', message: 'the session did not answer' },
    }
  }
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    result?: unknown
    error?: unknown
  }
  if (typeof body.ok === 'boolean') {
    if (body.ok) return { ok: true, result: body.result }
    const err = (body.error ?? {}) as { code?: string; message?: string }
    const code = err.code ?? `failed (${response.status})`
    return {
      ok: false,
      error: { code, message: err.message ?? ERROR_TEXT[code] ?? code },
    }
  }
  // A gateway-level refusal is a bare `{error: code}`, not a route answer.
  const code = typeof body.error === 'string' ? body.error : ''
  return {
    ok: false,
    error: {
      code: code || `failed (${response.status})`,
      message: ERROR_TEXT[code] ?? code ?? 'the session refused',
    },
  }
}

/** Resolves one transcript image's bytes, or null when the session has none. */
export async function fetchImage(
  processKey: string,
  itemId: string,
): Promise<WireImagePayload | null> {
  const response = await fetch(
    `/api/sessions/${processKey}/image?itemId=${encodeURIComponent(itemId)}`,
  ).catch(() => null)
  if (!response?.ok) return null
  return (await response
    .json()
    .catch((): null => null)) as WireImagePayload | null
}
