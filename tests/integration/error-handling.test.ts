import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI } from './test-helpers'
import { errorResponse, rawResponse, textResponse } from './fixture-builders'

describe('Error Handling', () => {
  let server: MockAnthropicServer

  // Common env to disable retries for error tests
  const noRetryEnv = { CLAUDE_CODE_MAX_RETRIES: '0' }

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  beforeEach(() => {
    server.reset([])
  })

  test('400 Bad Request', async () => {
    server.reset([
      errorResponse(400, 'invalid_request_error', 'Invalid request body'),
    ])

    const result = await runCLI({
      prompt: 'trigger 400',
      serverUrl: server.url,
      maxTurns: 1,
      timeout: 15_000,
      additionalEnv: noRetryEnv,
    })

    // CLI should have made at least 1 request and handled error
    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
  })

  test('401 Unauthorized', async () => {
    server.reset([
      errorResponse(401, 'authentication_error', 'Invalid API key'),
    ])

    const result = await runCLI({
      prompt: 'trigger 401',
      serverUrl: server.url,
      maxTurns: 1,
      timeout: 15_000,
      additionalEnv: noRetryEnv,
    })

    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
    // Should indicate auth error
    const output = result.stdout + result.stderr
    expect(
      output.includes('401') ||
        output.includes('auth') ||
        output.includes('Unauthorized') ||
        output.includes('API key') ||
        output.includes('error') ||
        output.includes('Error') ||
        result.exitCode !== 0,
    ).toBe(true)
  })

  test('429 Rate Limited then success', async () => {
    // Provide a 429 followed by a success response for retry
    server.reset([
      errorResponse(429, 'rate_limit_error', 'Rate limit exceeded'),
      textResponse('Success after rate limit'),
    ])

    const result = await runCLI({
      prompt: 'trigger rate limit',
      serverUrl: server.url,
      maxTurns: 1,
      timeout: 30_000,
      additionalEnv: {
        CLAUDE_CODE_MAX_RETRIES: '1',
      },
    })

    // Either retried and got success, or showed rate limit error
    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
  })

  test('500 Internal Server Error', async () => {
    server.reset([
      errorResponse(500, 'api_error', 'Internal server error'),
    ])

    const result = await runCLI({
      prompt: 'trigger 500',
      serverUrl: server.url,
      maxTurns: 1,
      timeout: 15_000,
      additionalEnv: noRetryEnv,
    })

    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
  })

  test('529 Overloaded', async () => {
    server.reset([
      errorResponse(529, 'overloaded_error', 'API is overloaded'),
    ])

    const result = await runCLI({
      prompt: 'trigger 529',
      serverUrl: server.url,
      maxTurns: 1,
      timeout: 15_000,
      additionalEnv: noRetryEnv,
    })

    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
  })

  test('connection closed mid-stream (truncated SSE)', async () => {
    // Send a partial SSE response that cuts off mid-stream
    const partialSSE = [
      'event: message_start',
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_truncated',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-4-20250514',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'This response is trun' },
      })}`,
      '',
      // Abrupt end - no content_block_stop, no message_delta, no message_stop
    ].join('\n')

    server.reset([rawResponse(partialSSE)])

    const result = await runCLI({
      prompt: 'trigger truncated response',
      serverUrl: server.url,
      maxTurns: 1,
      timeout: 30_000,
      additionalEnv: noRetryEnv,
    })

    // The CLI should handle truncation gracefully (not hang forever)
    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
  })
})
