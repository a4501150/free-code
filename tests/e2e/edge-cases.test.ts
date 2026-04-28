/**
 * Edge Cases E2E Tests
 *
 * Tests unusual inputs, large payloads, and boundary conditions
 * through the full interactive REPL.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

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
      await session.submitAndWaitForResponse(
        'Test with "double quotes" and backslashes',
      )

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

  describe('Permission Dialog During Typing', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    bunTest(
      'permission dialog appears even when user is actively typing',
      async () => {
        // Queue: first response triggers a Bash tool that needs permission
        // (touch is NOT read-only, so it always prompts for approval),
        // second response is the follow-up after approval.
        server.reset([
          toolUseResponse([
            {
              name: 'Bash',
              input: { command: 'touch /tmp/permission_during_typing_test' },
            },
          ]),
          textResponse('Tool completed successfully'),
        ])

        session = new TmuxSession({ serverUrl: server.url })
        await session.start()

        // Submit a prompt to trigger the agent loop
        await session.sendLine('Run echo command')
        await sleep(300)

        // Type partial text into the prompt input while the agent is processing.
        // This sets isPromptInputActive = true in the REPL.
        await session.sendText('some partial input')
        await sleep(200)

        // The permission dialog must appear despite active typing.
        // Under the bug, this would time out because the dialog is suppressed.
        await session.waitForText('Do you want to proceed', 15_000)

        // Approve the permission
        await session.sendSpecialKey('Enter')

        // Wait for completion
        await session.waitForPrompt()

        // The agent should have completed — verify API got 2 requests
        expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
      },
      30_000,
    )

    bunTest(
      'permission dialog can be approved and agent completes after typing',
      async () => {
        server.reset([
          toolUseResponse([
            {
              name: 'Bash',
              input: { command: 'touch /tmp/stash_test_file' },
            },
          ]),
          textResponse('Done after approval'),
        ])

        session = new TmuxSession({ serverUrl: server.url })
        await session.start()

        // Submit prompt to trigger agent loop
        await session.sendLine('Run a command')
        await sleep(300)

        // Type some text — it may or may not arrive before the dialog
        await session.sendText('draft')
        await sleep(200)

        // Permission dialog should appear (regardless of typed text)
        await session.waitForText('Do you want to proceed', 15_000)

        // Approve the permission
        await session.sendSpecialKey('Enter')

        // Wait for idle — agent should complete the full round trip
        await session.waitForPrompt()

        // Verify the tool ran and the follow-up response was sent
        const log = server.getRequestLog()
        expect(log.length).toBeGreaterThanOrEqual(2)

        // Verify the final response appears on screen
        const screen = await session.capturePaneWithHistory()
        expect(screen).toContain('Done after approval')
      },
      30_000,
    )
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
