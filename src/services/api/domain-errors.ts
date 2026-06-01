/**
 * Provider-agnostic transport error classes.
 *
 * These replace Anthropic SDK error classes (`APIError`, `APIConnectionError`,
 * `APIConnectionTimeoutError`, `APIUserAbortError`) as the domain-layer error
 * taxonomy. Every `DomainTransportError` carries a `NormalizedApiError` so
 * retry logic can branch on `error.normalized.kind` instead of `instanceof` +
 * status-code heuristics.
 *
 * Adapters throw these directly; the main loop never sees SDK error types.
 */
import type { NormalizedApiError } from '../../utils/normalizedError.js'

/**
 * Base class for all provider transport errors (HTTP errors, stream errors,
 * mid-stream failures). Always carries a {@link NormalizedApiError} for
 * downstream classification.
 */
export class DomainTransportError extends Error {
  readonly normalized: NormalizedApiError
  readonly status?: number
  readonly requestID?: string
  readonly headers?: Record<string, string>
  readonly retryAfterMs?: number
  readonly raw?: unknown

  constructor(opts: {
    normalized: NormalizedApiError
    status?: number
    requestID?: string
    headers?: Record<string, string>
    retryAfterMs?: number
    raw?: unknown
    cause?: unknown
  }) {
    super(opts.normalized.message, { cause: opts.cause })
    this.name = 'DomainTransportError'
    this.normalized = opts.normalized
    this.status = opts.status
    this.requestID = opts.requestID
    this.headers = opts.headers
    this.retryAfterMs = opts.retryAfterMs ?? opts.normalized.retryAfterMs
    this.raw = opts.raw
  }
}

/**
 * Transport/network failure before an HTTP status is known (DNS, TLS,
 * socket reset, missing response body, etc.).
 */
export class DomainConnectionError extends DomainTransportError {
  constructor(opts: ConstructorParameters<typeof DomainTransportError>[0]) {
    super(opts)
    this.name = 'DomainConnectionError'
  }
}

/**
 * Timeout subset of connection errors.
 */
export class DomainConnectionTimeoutError extends DomainConnectionError {
  constructor(opts: ConstructorParameters<typeof DomainTransportError>[0]) {
    super(opts)
    this.name = 'DomainConnectionTimeoutError'
  }
}

/**
 * User-initiated abort (ESC key, signal.abort()). Not a transport error —
 * should never be retried. Intentionally extends plain `Error`, not
 * `DomainTransportError`, so retry predicates naturally exclude it.
 */
export class DomainUserAbortError extends Error {
  override readonly name = 'DomainUserAbortError'

  constructor(message = 'Request was aborted by the user') {
    super(message)
  }
}
