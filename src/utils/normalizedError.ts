/**
 * Normalized provider-error taxonomy.
 *
 * Unifies the error shapes from every provider (Anthropic HTTP, OpenAI chat,
 * OpenAI Responses, Gemini, Bedrock EventStream, Vertex, Foundry) into a
 * single discriminated value that downstream code — the retry layer, the
 * user-facing error banner, telemetry — can branch on without HTTP-status
 * heuristics or message-string matching.
 *
 * Producer side: each adapter's `normalizeError(raw, providerType)` returns
 * a `NormalizedApiError`. Consumer side: `toAnthropicErrorType(kind)` maps
 * kind → Anthropic's error `type` field so synthetic Anthropic-shape error
 * bodies stay wire-compatible.
 */
import type { ProviderType } from './settings/types.js'

export type NormalizedApiErrorKind =
  /** 429, explicit quota / rate-limit exceeded. */
  | 'rate_limit'
  /** 529 or provider-specific capacity error (Anthropic `overloaded_error`). */
  | 'overloaded'
  /** 401 / 403, revoked/expired OAuth, invalid API key, missing credentials. */
  | 'auth'
  /** 400 / 404, schema violations, unknown model, bad request shape. */
  | 'invalid_request'
  /**
   * Provider refused to generate content. Gemini SAFETY/RECITATION,
   * OpenAI `content_filter`, Codex `refusal` output item.
   */
  | 'content_filter'
  /** Network, DNS, TLS, fetch-level failure before a status is known. */
  | 'transport'
  /** 5xx excluding 529. */
  | 'server'
  /** Catch-all. */
  | 'unknown'

export type NormalizedApiError = {
  kind: NormalizedApiErrorKind
  /** Human-readable, provider-trimmed. */
  message: string
  /** HTTP status if available (undefined for mid-stream or transport errors). */
  status?: number
  /**
   * Milliseconds until retry is permitted, read from `retry-after` / provider
   * hints. Undefined when no hint is available.
   */
  retryAfterMs?: number
  providerType: ProviderType
  /** Opaque original payload for diagnostic logging. */
  raw: unknown
}

/**
 * Map a normalized kind to the Anthropic `error.type` string consumers
 * expect on the wire. Preserves Anthropic SDK classifier behavior.
 */
export function toAnthropicErrorType(kind: NormalizedApiErrorKind): string {
  switch (kind) {
    case 'rate_limit':
      return 'rate_limit_error'
    case 'overloaded':
      return 'overloaded_error'
    case 'auth':
      return 'authentication_error'
    case 'invalid_request':
      return 'invalid_request_error'
    case 'content_filter':
      return 'refusal'
    case 'transport':
    case 'server':
    case 'unknown':
      return 'api_error'
  }
}

/** Read `retry-after` (seconds or HTTP-date) to a millisecond offset. */
function parseRetryAfter(
  headers: Headers | Record<string, string> | undefined,
): number | undefined {
  if (!headers) return undefined
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers['retry-after'] ?? headers['Retry-After'])
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const when = Date.parse(raw)
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  return undefined
}

/**
 * Map an HTTP status code to a NormalizedApiError. Use for the shared
 * "response.ok is false" branch in every fetch adapter.
 */
export function fromHttpStatus(
  status: number,
  message: string,
  providerType: ProviderType,
  headers?: Headers | Record<string, string>,
  raw: unknown = null,
): NormalizedApiError {
  const retryAfterMs = parseRetryAfter(headers)
  let kind: NormalizedApiErrorKind
  if (status === 429) kind = 'rate_limit'
  else if (status === 529) kind = 'overloaded'
  else if (status === 401 || status === 403) kind = 'auth'
  else if (status === 400 || status === 404) kind = 'invalid_request'
  else if (status >= 500 && status < 600) kind = 'server'
  else kind = 'unknown'
  return {
    kind,
    message,
    status,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    providerType,
    raw,
  }
}
