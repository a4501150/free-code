/**
 * Unit tests for domain error classes.
 */
import { describe, test, expect } from 'bun:test'
import {
  DomainTransportError,
  DomainConnectionError,
  DomainConnectionTimeoutError,
  DomainUserAbortError,
} from '../../src/services/api/domain-errors.js'
import type { NormalizedApiError } from '../../src/utils/normalizedError.js'

function makeNormalized(
  overrides: Partial<NormalizedApiError> = {},
): NormalizedApiError {
  return {
    kind: 'transport',
    message: 'test error',
    providerType: 'anthropic',
    raw: null,
    ...overrides,
  }
}

describe('DomainTransportError', () => {
  test('carries normalized error and all properties', () => {
    const normalized = makeNormalized({
      kind: 'rate_limit',
      message: 'too many requests',
      status: 429,
      retryAfterMs: 5000,
    })
    const err = new DomainTransportError({
      normalized,
      status: 429,
      requestID: 'req_123',
      headers: { 'retry-after': '5' },
      retryAfterMs: 5000,
      raw: { original: true },
    })

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DomainTransportError)
    expect(err.name).toBe('DomainTransportError')
    expect(err.message).toBe('too many requests')
    expect(err.normalized.kind).toBe('rate_limit')
    expect(err.status).toBe(429)
    expect(err.requestID).toBe('req_123')
    expect(err.headers?.['retry-after']).toBe('5')
    expect(err.retryAfterMs).toBe(5000)
    expect(err.raw).toEqual({ original: true })
  })

  test('retryAfterMs falls back to normalized.retryAfterMs', () => {
    const err = new DomainTransportError({
      normalized: makeNormalized({ retryAfterMs: 3000 }),
    })
    expect(err.retryAfterMs).toBe(3000)
  })

  test('retryAfterMs prefers explicit over normalized', () => {
    const err = new DomainTransportError({
      normalized: makeNormalized({ retryAfterMs: 3000 }),
      retryAfterMs: 7000,
    })
    expect(err.retryAfterMs).toBe(7000)
  })
})

describe('DomainConnectionError', () => {
  test('instanceof chain', () => {
    const err = new DomainConnectionError({
      normalized: makeNormalized(),
    })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DomainTransportError)
    expect(err).toBeInstanceOf(DomainConnectionError)
    expect(err.name).toBe('DomainConnectionError')
  })
})

describe('DomainConnectionTimeoutError', () => {
  test('instanceof chain', () => {
    const err = new DomainConnectionTimeoutError({
      normalized: makeNormalized(),
    })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DomainTransportError)
    expect(err).toBeInstanceOf(DomainConnectionError)
    expect(err).toBeInstanceOf(DomainConnectionTimeoutError)
    expect(err.name).toBe('DomainConnectionTimeoutError')
  })
})

describe('DomainUserAbortError', () => {
  test('is not a DomainTransportError', () => {
    const err = new DomainUserAbortError()
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DomainTransportError)
    expect(err.name).toBe('DomainUserAbortError')
    expect(err.message).toBe('Request was aborted by the user')
  })

  test('accepts custom message', () => {
    const err = new DomainUserAbortError('custom abort')
    expect(err.message).toBe('custom abort')
  })
})

describe('Error classification via normalized.kind', () => {
  const kinds = [
    'rate_limit',
    'overloaded',
    'auth',
    'invalid_request',
    'context_overflow',
    'content_filter',
    'transport',
    'server',
    'unknown',
  ] as const

  for (const kind of kinds) {
    test(`DomainTransportError with kind=${kind} accessible`, () => {
      const err = new DomainTransportError({
        normalized: makeNormalized({ kind }),
      })
      expect(err.normalized.kind).toBe(kind)
    })
  }
})
