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

  test('mid-stream transport error without refusal → unknown', () => {
    const e = codexAdapter.normalizeError(
      { mid_stream: true, cause: new Error('abrupt close') },
      'openai-responses',
    )
    expect(e.kind).toBe('unknown')
    expect(e.message).toContain('abrupt close')
  })

  test('HTTP 401 → auth', () => {
    const e = codexAdapter.normalizeError(
      { status: 401, body: '' },
      'openai-responses',
    )
    expect(e.kind).toBe('auth')
  })

  test('HTTP 400 with context_length_exceeded code → invalid_request', () => {
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
    expect(e.kind).toBe('invalid_request')
    expect(e.message).toBe('Maximum context length exceeded')
  })
})
