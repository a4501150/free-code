/**
 * Edge Cases E2E Tests
 *
 * Tests unusual inputs, large payloads, and boundary conditions
 * through the full interactive REPL.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep } from './tmux-helpers'

describe('Edge Cases', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  describe('Special Characters', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('special characters in prompt (quotes, backslashes)', async () => {
      server.reset([textResponse('Received special chars')])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // No tool use — just a text response, no permission needed
      await session.submitAndWaitForResponse('Test with "double quotes" and backslashes')

      // Verify the prompt was sent correctly to the API
      const log = server.getRequestLog()
      expect(log.length).toBe(1)

      const messages = log[0].body.messages as Array<{
        role: string
        content: unknown
      }>
      expect(messages.length).toBeGreaterThanOrEqual(1)

      const userContent = messages[0].content
      const contentStr =
        typeof userContent === 'string'
          ? userContent
          : JSON.stringify(userContent)
      expect(contentStr).toContain('double quotes')
    })
  })

  describe('Large Payloads', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('tool with large JSON input', async () => {
      const largeInput: Record<string, unknown> = {
        command: 'echo "large input test"',
        description: 'x'.repeat(5000),
      }

      server.reset([
        toolUseResponse([{ name: 'Bash', input: largeInput }]),
        textResponse('Large input handled'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool use = 1 permission approval
      await session.submitAndApprove('Large input test', 30_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
    })

    test('tool with large output', async () => {
      server.reset([
        toolUseResponse([
          {
            name: 'Bash',
            input: { command: 'python3 -c "print(\'x\' * 50000)"' },
          },
        ]),
        textResponse('Handled the large output'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool use = 1 permission approval
      await session.submitAndApprove('Large output test', 30_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Multiple Content Blocks', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('multiple text blocks in one response', async () => {
      server.reset([
        {
          kind: 'success' as const,
          response: {
            content: [
              { type: 'text' as const, text: 'First text block. ' },
              { type: 'text' as const, text: 'Second text block.' },
            ],
            stop_reason: 'end_turn' as const,
          },
        },
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // No tool use — just text blocks, no permission needed
      const screen = await session.submitAndWaitForResponse('Multiple blocks')

      expect(
        screen.includes('First text block') ||
          screen.includes('Second text block'),
      ).toBe(true)
    })
  })
})
