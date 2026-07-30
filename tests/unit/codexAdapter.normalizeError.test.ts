/**
 * Unit test: codex adapter normalizeError.
 */
import { describe, test, expect } from 'bun:test'
import { codexAdapter } from '../../src/services/api/adapters/codex-adapter-impl.js'

describe('codexAdapter.normalizeError', () => {
  test('HTTP 429 → rate_limit', () => {
    const e = codexAdapter.normalizeError(
      { status: 429, body: '' },
      'openai-responses',
    )
    expect(e.kind).toBe('rate_limit')
  })

  test('refusal output item → content_filter', () => {
    const e = codexAdapter.normalizeError(
      { mid_stream: true, refusal: true, cause: new Error('refused') },
      'openai-responses',
    )
    expect(e.kind).toBe('content_filter')
  })

  test('mid-stream transport error without refusal → transport (retryable)', () => {
    const e = codexAdapter.normalizeError(
      { mid_stream: true, cause: new Error('abrupt close') },
      'openai-responses',
    )
    expect(e.kind).toBe('transport')
    expect(e.message).toContain('abrupt close')
  })

  test('truncated stream before response.completed → transport', () => {
    const e = codexAdapter.normalizeError(
      {
        mid_stream: true,
        stream_truncated: true,
        cause: new Error('Codex stream ended before response.completed'),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('transport')
    expect(e.message).toContain('response.completed')
  })

  test('mid-stream server_error body → server', () => {
    const e = codexAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: {
            type: 'server_error',
            code: 'server_error',
            message: 'An error occurred while processing your request.',
          },
        }),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('server')
    expect(e.message).toBe('An error occurred while processing your request.')
  })

  test('HTTP 401 → auth', () => {
    const e = codexAdapter.normalizeError(
      { status: 401, body: '' },
      'openai-responses',
    )
    expect(e.kind).toBe('auth')
  })

  test('HTTP 400 with context_length_exceeded code → context_overflow', () => {
    const e = codexAdapter.normalizeError(
      {
        status: 400,
        body: JSON.stringify({
          error: {
            code: 'context_length_exceeded',
            message: 'Maximum context length exceeded',
          },
        }),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('context_overflow')
    expect(e.message).toBe('Maximum context length exceeded')
  })

  test('server_is_overloaded code → overloaded', () => {
    const e = codexAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: {
            code: 'server_is_overloaded',
            message: 'The server is currently overloaded.',
          },
        }),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('overloaded')
  })

  test('slow_down code → overloaded', () => {
    const e = codexAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: {
            code: 'slow_down',
            message: 'Please slow down.',
          },
        }),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('overloaded')
  })

  test('rate_limit_exceeded with retry delay → rate_limit with retryAfterMs', () => {
    const e = codexAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: {
            code: 'rate_limit_exceeded',
            message:
              'Rate limit reached for gpt-5.1 in organization org-AAA on tokens per min (TPM): Limit 30000, Used 22999, Requested 12528. Please try again in 11.054s.',
          },
        }),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('rate_limit')
    expect(e.retryAfterMs).toBe(11054)
  })

  test('rate_limit_exceeded with ms delay → rate_limit with retryAfterMs', () => {
    const e = codexAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: {
            code: 'rate_limit_exceeded',
            message: 'Rate limit reached. Please try again in 28ms.',
          },
        }),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('rate_limit')
    expect(e.retryAfterMs).toBe(28)
  })

  test('rate_limit_exceeded without delay → rate_limit without retryAfterMs', () => {
    const e = codexAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: {
            code: 'rate_limit_exceeded',
            message: 'Rate limit exceeded.',
          },
        }),
      },
      'openai-responses',
    )
    expect(e.kind).toBe('rate_limit')
    expect(e.retryAfterMs).toBeUndefined()
  })
})
