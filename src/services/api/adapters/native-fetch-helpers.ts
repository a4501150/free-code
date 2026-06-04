import type { ProviderType } from '../../../utils/settings/types.js'
import type {
  DomainStreamEvent,
  DomainStreamingResponse,
} from '../domain-transport.js'
import {
  DomainConnectionError,
  DomainTransportError,
  DomainUserAbortError,
} from '../domain-errors.js'
import type { NormalizeErrorFn } from '../adapter.js'

export function handleFetchError(
  error: unknown,
  signal: AbortSignal,
  providerType: ProviderType,
  normalizeError: NormalizeErrorFn,
): never {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || signal.aborted)
  ) {
    throw new DomainUserAbortError()
  }

  const normalized = normalizeError(
    { cause: error, mid_stream: false },
    providerType,
  )
  throw new DomainConnectionError({
    normalized: { ...normalized, kind: 'transport' },
    cause: error,
    raw: error,
  })
}

export async function assertOkResponse(
  response: Response,
  providerType: ProviderType,
  normalizeError: NormalizeErrorFn,
): Promise<void> {
  if (response.ok) return

  const errorText = await response.text()
  const normalized = normalizeError(
    { status: response.status, body: errorText, headers: response.headers },
    providerType,
  )
  throw new DomainTransportError({
    normalized,
    status: response.status,
    headers: headersToRecord(response.headers),
    raw: { status: response.status, body: errorText },
  })
}

export function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

export function assertResponseBody(
  response: Response,
  providerType: ProviderType,
): ReadableStream<Uint8Array> {
  if (!response.body) {
    throw new DomainConnectionError({
      normalized: {
        kind: 'transport',
        message: 'No response body',
        providerType,
        raw: null,
      },
      cause: null,
      raw: null,
    })
  }

  return response.body
}

export function makeStreamingResponse(opts: {
  response: Response
  stream: AsyncGenerator<DomainStreamEvent>
  requestIdHeader: string
}): DomainStreamingResponse {
  return {
    stream: opts.stream,
    requestId: opts.response.headers.get(opts.requestIdHeader) ?? undefined,
    responseHeaders: headersToRecord(opts.response.headers),
    abort() {
      // no-op for now
    },
    release() {
      if (opts.response.body) {
        opts.response.body.cancel().catch(() => {})
      }
    },
  }
}
