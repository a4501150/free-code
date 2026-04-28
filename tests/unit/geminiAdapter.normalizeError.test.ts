/**
 * Unit test: gemini adapter normalizeError.
 */
import { describe, test, expect } from 'bun:test'
import { geminiAdapter } from '../../src/services/api/adapters/gemini-adapter-impl.js'

describe('geminiAdapter.normalizeError', () => {
  test('finishReason SAFETY → content_filter', () => {
    const e = geminiAdapter.normalizeError({ finishReason: 'SAFETY' }, 'gemini')
    expect(e.kind).toBe('content_filter')
    expect(e.message).toContain('SAFETY')
  })

  test('finishReason RECITATION → content_filter', () => {
    const e = geminiAdapter.normalizeError(
      { finishReason: 'RECITATION' },
      'gemini',
    )
    expect(e.kind).toBe('content_filter')
  })

  test('HTTP 429 with RESOURCE_EXHAUSTED status → rate_limit', () => {
    const e = geminiAdapter.normalizeError(
      {
        status: 429,
        body: JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'quota exceeded',
          },
        }),
      },
      'gemini',
    )
    expect(e.kind).toBe('rate_limit')
  })

  test('HTTP 403 with PERMISSION_DENIED → auth', () => {
    const e = geminiAdapter.normalizeError(
      {
        status: 403,
        body: JSON.stringify({
          error: { status: 'PERMISSION_DENIED', message: 'denied' },
        }),
      },
      'gemini',
    )
    expect(e.kind).toBe('auth')
  })

  test('mid-stream with RESOURCE_EXHAUSTED in parsed body → rate_limit', () => {
    const e = geminiAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: { status: 'RESOURCE_EXHAUSTED', message: 'boom' },
        }),
      },
      'gemini',
    )
    expect(e.kind).toBe('rate_limit')
  })
})
