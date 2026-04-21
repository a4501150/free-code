/**
 * Unit test: shared NormalizedApiError mapping helpers.
 */
import { describe, test, expect } from 'bun:test'
import {
  fromHttpStatus,
  toAnthropicErrorType,
} from '../../src/utils/normalizedError.js'

describe('fromHttpStatus', () => {
  test('429 → rate_limit', () => {
    const e = fromHttpStatus(429, 'too fast', 'anthropic')
    expect(e.kind).toBe('rate_limit')
    expect(e.status).toBe(429)
    expect(e.providerType).toBe('anthropic')
  })

  test('529 → overloaded', () => {
    expect(fromHttpStatus(529, '', 'anthropic').kind).toBe('overloaded')
  })

  test('401/403 → auth', () => {
    expect(fromHttpStatus(401, '', 'anthropic').kind).toBe('auth')
    expect(fromHttpStatus(403, '', 'anthropic').kind).toBe('auth')
  })

  test('400/404 → invalid_request', () => {
    expect(fromHttpStatus(400, '', 'anthropic').kind).toBe('invalid_request')
    expect(fromHttpStatus(404, '', 'anthropic').kind).toBe('invalid_request')
  })

  test('5xx (not 529) → server', () => {
    expect(fromHttpStatus(500, '', 'anthropic').kind).toBe('server')
    expect(fromHttpStatus(503, '', 'anthropic').kind).toBe('server')
    expect(fromHttpStatus(599, '', 'anthropic').kind).toBe('server')
  })

  test('parses retry-after seconds from Headers', () => {
    const headers = new Headers({ 'retry-after': '10' })
    const e = fromHttpStatus(429, 'x', 'anthropic', headers)
    expect(e.retryAfterMs).toBe(10000)
  })

  test('parses retry-after seconds from plain object', () => {
    const e = fromHttpStatus(429, 'x', 'anthropic', { 'retry-after': '5' })
    expect(e.retryAfterMs).toBe(5000)
  })

  test('omits retryAfterMs when header absent', () => {
    const e = fromHttpStatus(429, 'x', 'anthropic')
    expect(e.retryAfterMs).toBeUndefined()
  })
})

describe('toAnthropicErrorType', () => {
  test('maps each kind to the expected Anthropic type string', () => {
    expect(toAnthropicErrorType('rate_limit')).toBe('rate_limit_error')
    expect(toAnthropicErrorType('overloaded')).toBe('overloaded_error')
    expect(toAnthropicErrorType('auth')).toBe('authentication_error')
    expect(toAnthropicErrorType('invalid_request')).toBe('invalid_request_error')
    expect(toAnthropicErrorType('content_filter')).toBe('refusal')
    expect(toAnthropicErrorType('transport')).toBe('api_error')
    expect(toAnthropicErrorType('server')).toBe('api_error')
    expect(toAnthropicErrorType('unknown')).toBe('api_error')
  })
})
