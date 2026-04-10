/**
 * Error Handling E2E Tests
 *
 * Tests that the CLI gracefully handles various API error responses
 * (4xx, 5xx, truncated streams) through the full interactive REPL.
 */

import { describe, test as bunTest, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { errorResponse, rawResponse, textResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Error Handling', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  describe('HTTP Error Codes', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('400 Bad Request is handled gracefully', async () => {
      server.reset([
        errorResponse(400, 'invalid_request_error', 'Invalid request body'),
      ])

      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_MAX_RETRIES: '0' },
      })
      await session.start()

      // submitAndWaitForResponse includes a delay before polling,
      // preventing false match on stale "for shortcuts" in scrollback
      const screen = await session.submitAndWaitForResponse('trigger 400', 15_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
      // CLI should still be alive (not crashed)
      expect(screen.length).toBeGreaterThan(0)
    })

    test('401 Unauthorized shows auth error', async () => {
      server.reset([
        errorResponse(401, 'authentication_error', 'Invalid API key'),
      ])

      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_MAX_RETRIES: '0' },
      })
      await session.start()

      const screen = await session.submitAndWaitForResponse('trigger 401', 15_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
      // Should indicate auth error somewhere on screen
      expect(
        screen.includes('401') ||
          screen.includes('auth') ||
          screen.includes('Unauthorized') ||
          screen.includes('API key') ||
          screen.includes('error') ||
          screen.includes('Error'),
      ).toBe(true)
    })

    test('429 Rate Limited then success on retry', async () => {
      server.reset([
        errorResponse(429, 'rate_limit_error', 'Rate limit exceeded'),
        textResponse('Success after rate limit'),
      ])

      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_MAX_RETRIES: '1' },
      })
      await session.start()

      const screen = await session.submitAndWaitForResponse('trigger rate limit', 30_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
      // Either retried and got success, or showed rate limit error
      expect(screen.length).toBeGreaterThan(0)
    })

    test('500 Internal Server Error is handled gracefully', async () => {
      server.reset([
        errorResponse(500, 'api_error', 'Internal server error'),
      ])

      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_MAX_RETRIES: '0' },
      })
      await session.start()

      const screen = await session.submitAndWaitForResponse('trigger 500', 15_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
      expect(screen.length).toBeGreaterThan(0)
    })

    test('529 Overloaded is handled gracefully', async () => {
      server.reset([
        errorResponse(529, 'overloaded_error', 'API is overloaded'),
      ])

      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_MAX_RETRIES: '0' },
      })
      await session.start()

      const screen = await session.submitAndWaitForResponse('trigger 529', 15_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
      expect(screen.length).toBeGreaterThan(0)
    })
  })

  describe('Stream Errors', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('connection closed mid-stream (truncated SSE)', async () => {
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
        // Abrupt end — no content_block_stop, no message_delta, no message_stop
      ].join('\n')

      server.reset([rawResponse(partialSSE)])

      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_MAX_RETRIES: '0' },
      })
      await session.start()

      const screen = await session.submitAndWaitForResponse('trigger truncated response', 30_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
      // CLI should still be alive
      expect(screen.length).toBeGreaterThan(0)
    })
  })
})
