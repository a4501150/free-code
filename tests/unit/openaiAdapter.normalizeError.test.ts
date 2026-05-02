/**
 * Unit test: openai-chat-completions adapter normalizeError.
 */
import { describe, test, expect } from 'bun:test'
import { openaiChatCompletionsAdapter } from '../../src/services/api/adapters/openai-chat-completions-adapter-impl.js'

describe('openaiChatCompletionsAdapter.normalizeError', () => {
  test('HTTP 429 with rate_limit_exceeded code → rate_limit', () => {
    const e = openaiChatCompletionsAdapter.normalizeError(
      {
        status: 429,
        body: JSON.stringify({
          error: { code: 'rate_limit_exceeded', message: 'rate limit' },
        }),
      },
      'openai-chat-completions',
    )
    expect(e.kind).toBe('rate_limit')
    expect(e.status).toBe(429)
    expect(e.message).toBe('rate limit')
  })

  test('HTTP 400 with content_filter code → content_filter', () => {
    const e = openaiChatCompletionsAdapter.normalizeError(
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 'content_filter', message: 'blocked' },
        }),
      },
      'openai-chat-completions',
    )
    expect(e.kind).toBe('content_filter')
  })

  test('HTTP 401 → auth', () => {
    const e = openaiChatCompletionsAdapter.normalizeError(
      { status: 401, body: '' },
      'openai-chat-completions',
    )
    expect(e.kind).toBe('auth')
  })

  test('HTTP 400 with context_length_exceeded code → invalid_request', () => {
    const e = openaiChatCompletionsAdapter.normalizeError(
      {
        status: 400,
        body: JSON.stringify({
          error: {
            code: 'context_length_exceeded',
            message: 'Maximum context length exceeded',
          },
        }),
      },
      'openai-chat-completions',
    )
    expect(e.kind).toBe('invalid_request')
    expect(e.message).toBe('Maximum context length exceeded')
  })

  test('mid-stream with insufficient_quota code → rate_limit', () => {
    const e = openaiChatCompletionsAdapter.normalizeError(
      {
        mid_stream: true,
        body: JSON.stringify({
          error: { code: 'insufficient_quota', message: 'no credits' },
        }),
      },
      'openai-chat-completions',
    )
    expect(e.kind).toBe('rate_limit')
    expect(e.status).toBeUndefined()
  })

  test('mid-stream without recognizable code → unknown', () => {
    const e = openaiChatCompletionsAdapter.normalizeError(
      { mid_stream: true, cause: new Error('socket closed') },
      'openai-chat-completions',
    )
    expect(e.kind).toBe('unknown')
    expect(e.message).toContain('socket closed')
  })
})
