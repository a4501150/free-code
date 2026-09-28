import { readAttachDescriptor } from '../../server/descriptor.js'
import { SURFACE_TOKEN_HEADER } from '../../server/surface.js'
import type {
  WireImagePayload,
  WireSessionMeta,
  WireTranscriptSnapshot,
  WireEventEnvelope,
  WireEvent,
} from '../../session/wire.js'

export type SurfaceClientEvents = {
  onEvent(seq: number, event: WireEvent): void
  onClose(reason: string): void
}

/** The surface's answer to a command POST. */
export type SurfaceResponse = {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type SurfaceCommandPath =
  | 'prompt'
  | 'cancel'
  | 'request_respond'
  | 'model'
  | 'mode'
  | 'rpc'

export type SurfaceClient = {
  readonly pid: number
  readonly processNonce: string
  readonly meta: WireSessionMeta
  /** The session id this client verified at connect; a switch moves it. */
  readonly currentSessionId: string
  command(path: SurfaceCommandPath, body?: unknown): Promise<SurfaceResponse>
  image(itemId: string): Promise<WireImagePayload | null>
  agentTranscript(agentId: string): Promise<WireTranscriptSnapshot | null>
  close(): void
}

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Connects to one session process's wire surface (HTTP commands + SSE events).
 *
 * Every permission and ownership check lives in `readAttachDescriptor`, so this
 * refuses to connect to a port it cannot verify rather than trusting the file.
 */
export async function connectSurfaceClient(
  pid: number,
  handlers: SurfaceClientEvents,
  /** Resume a known stream position instead of taking a fresh snapshot. */
  options?: {
    lastEventId?: number
    /**
     * Attach a session other than the descriptor's primary by id. Multi-session
     * hosts (sessiond) serve every hosted id on one port and token; the
     * descriptor's `sessionIds` is how a caller learns the candidates.
     */
    sessionId?: string
    /**
     * Reach the surface at this origin instead of the descriptor's loopback
     * port (a port-forward). The token still comes from the descriptor; a
     * caller passing `url` trusts the channel it opens over the loopback one.
     */
    url?: string
  },
): Promise<SurfaceClient> {
  const descriptor = readAttachDescriptor(pid)
  if (!descriptor.ok) {
    throw new Error(`surface descriptor for pid ${pid}: ${descriptor.reason}`)
  }
  const { port, token, processNonce, sessionId } = descriptor.descriptor
  const base = options?.url ?? `http://127.0.0.1:${port}`
  let currentSessionId = options?.sessionId ?? sessionId

  const controller = new AbortController()
  let closed = false

  function headers(lastEventId?: number): HeadersInit {
    return {
      [SURFACE_TOKEN_HEADER]: token,
      ...(lastEventId !== undefined
        ? { 'last-event-id': String(lastEventId) }
        : {}),
    }
  }

  async function requestJson(
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await fetch(path, {
      ...init,
      headers: { ...init.headers, [SURFACE_TOKEN_HEADER]: token },
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    })
    // The surface answers every route with a JSON envelope, refusals included
    // (a 503 `runtime_not_ready` is a retry signal callers act on, not a
    // transport failure). Only a non-JSON answer means the peer is not the
    // surface we think we are talking to.
    if (
      !(response.headers.get('content-type') ?? '').includes('application/json')
    ) {
      throw new Error(`surface answered ${response.status} for ${path}`)
    }
    return response.json()
  }

  // Handshake: the meta route proves the surface is live and carries the
  // identity the caller compares against the session list.
  const meta = (await requestJson(
    `${base}/v1/sessions/${currentSessionId}/meta`,
    {
      method: 'GET',
      headers: headers(),
    },
  )) as WireSessionMeta

  // The event stream. Frames are `id: <seq>\ndata: <json>\n\n`; anything
  // unparseable is skipped, same posture as the v1 ndjson reader.
  void (async () => {
    try {
      const response = await fetch(
        `${base}/v1/sessions/${currentSessionId}/events`,
        {
          method: 'GET',
          headers: headers(options?.lastEventId),
          signal: controller.signal,
        },
      )
      if (!response.ok || !response.body) {
        throw new Error(`surface events route answered ${response.status}`)
      }
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frame
            .split('\n')
            .find(line => line.startsWith('data: '))
          if (dataLine) {
            try {
              const envelope = JSON.parse(
                dataLine.slice(6),
              ) as WireEventEnvelope
              if (envelope.event?.kind === 'session_changed') {
                // /resume and /clear move the identity; the old path 404s
                // from then on, so every later route must use the new one.
                currentSessionId = (envelope.event as { sessionId: string })
                  .sessionId
              }
              handlers.onEvent(envelope.seq, envelope.event)
            } catch {
              // A frame we cannot parse is not worth tearing the stream down for.
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
      // The stream ended without a close request: the process is gone.
      if (!closed) handlers.onClose('stream ended')
    } catch {
      if (!closed) handlers.onClose('stream failed')
    }
  })()

  function command(
    path: SurfaceCommandPath,
    body?: unknown,
  ): Promise<SurfaceResponse> {
    if (closed) {
      return Promise.resolve({
        ok: false,
        error: { code: 'closed', message: 'client is closed' },
      })
    }
    return requestJson(`${base}/v1/sessions/${currentSessionId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
      .then(parsed => parsed as SurfaceResponse)
      .catch(() => ({
        ok: false,
        error: { code: 'unreachable', message: 'the session did not answer' },
      }))
  }

  return {
    pid,
    processNonce,
    meta,
    get currentSessionId() {
      return currentSessionId
    },
    command,
    async image(itemId: string): Promise<WireImagePayload | null> {
      try {
        const result = (await requestJson(
          `${base}/v1/sessions/${currentSessionId}/image?itemId=${encodeURIComponent(itemId)}`,
          { method: 'GET', headers: headers() },
        )) as Partial<WireImagePayload> | null
        // A refusal arrives as a parsed error envelope, not a payload.
        return result?.mediaType && result?.data
          ? (result as WireImagePayload)
          : null
      } catch {
        return null
      }
    },
    async agentTranscript(
      agentId: string,
    ): Promise<WireTranscriptSnapshot | null> {
      try {
        const result = (await requestJson(
          `${base}/v1/sessions/${currentSessionId}/agents/${encodeURIComponent(agentId)}/transcript`,
          { method: 'GET', headers: headers() },
        )) as Partial<WireTranscriptSnapshot> | null
        return Array.isArray(result?.items) && Array.isArray(result?.order)
          ? (result as WireTranscriptSnapshot)
          : null
      } catch {
        return null
      }
    },
    close() {
      closed = true
      controller.abort()
    },
  }
}
