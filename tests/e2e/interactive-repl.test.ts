/**
 * Interactive REPL E2E Tests
 *
 * These tests launch the CLI in a tmux session (simulating a real terminal)
 * and verify the full interactive experience: startup, prompt submission,
 * tool execution, and response rendering.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { MockAnthropicServer } from '../integration/mock-server'
import { textResponse, toolUseResponse } from '../integration/fixture-builders'
import { TmuxSession, sleep } from './tmux-helpers'

describe('Interactive REPL E2E', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  describe('Startup', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('shows welcome screen and input prompt', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const screen = await session.capturePane()

      // Should show the version banner
      expect(screen).toContain('Claude Code')

      // Should show the model name
      expect(screen).toContain('Sonnet')

      // Should show the input prompt hint
      expect(screen).toContain('for shortcuts')
    })

    test('shows model and billing info', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const screen = await session.capturePane()

      // Should show model info
      expect(screen).toContain('Sonnet 4.6')
      // Should show billing type
      expect(screen).toContain('API Usage Billing')
    })
  })

  describe('Prompt Submission', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('user types a prompt and gets a text response', async () => {
      server.reset([textResponse('Hello from the mock API!')])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // Type a prompt and press Enter
      await session.sendLine('Say hello to me')

      // Wait for the response to appear on screen
      const screen = await session.waitForText('Hello from the mock API!', 15_000)

      expect(screen).toContain('Hello from the mock API!')
    })

    test('response renders and returns to input prompt', async () => {
      server.reset([textResponse('Quick response here')])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.sendLine('Quick test')

      // Wait for the response text
      await session.waitForText('Quick response here', 15_000)

      // Wait for the input prompt to return (CLI is ready for next input)
      // The prompt area shows "for shortcuts" or "Try ..." as hints
      await session.waitForPrompt(15_000)

      const screen = await session.capturePane()
      expect(screen).toContain('Quick response here')
    })

    test('tool execution visible on screen', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "e2e_tool_test"' } },
        ]),
        textResponse('The command output e2e_tool_test successfully.'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.sendLine('Run echo command')

      // Wait for the final response
      const screen = await session.waitForText('e2e_tool_test', 20_000)

      // Should show evidence of tool execution and response
      expect(screen).toContain('e2e_tool_test')
    })
  })

  describe('Multiple Turns', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('user can submit multiple prompts in one session', async () => {
      server.reset([
        textResponse('First answer: the sky is blue'),
        textResponse('Second answer: water is wet'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // First prompt
      await session.sendLine('What color is the sky?')
      await session.waitForText('First answer', 15_000)
      await session.waitForPrompt(15_000)

      // Second prompt
      await session.sendLine('What is water?')
      await session.waitForText('Second answer', 15_000)

      // Both responses should be in the scrollback
      const history = await session.capturePaneWithHistory()
      expect(history).toContain('First answer')
      expect(history).toContain('Second answer')

      // Server should have received 2 API requests
      expect(server.getRequestCount()).toBe(2)
    })
  })

  describe('Slash Commands', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('/help shows shortcuts and documentation', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.sendLine('/help')

      // Wait for help content - it shows "Shortcuts" section
      const screen = await session.waitForText('Shortcuts', 10_000)
      expect(screen).toContain('Shortcuts')
      // Should show some keyboard shortcuts
      expect(screen).toContain('bash mode')
    })

    test('/model shows model selector', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.sendLine('/model')

      // Wait for model selection UI
      await sleep(2000)
      const screen = await session.capturePaneWithHistory()

      // Should show model-related content
      expect(
        screen.includes('Sonnet') ||
          screen.includes('Opus') ||
          screen.includes('Haiku') ||
          screen.includes('model'),
      ).toBe(true)
    })
  })

  describe('Keyboard Interaction', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('Ctrl+C does not crash the REPL', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // Type some partial text
      await session.sendKeys('partial input')
      await sleep(300)

      // Press Ctrl+C
      await session.sendSpecialKey('C-c')
      await sleep(1500)

      // The REPL should still be alive (showing the prompt or exit hint)
      const screen = await session.capturePane()
      // Should contain either the normal prompt, an exit hint, or the logo
      expect(
        screen.includes('for shortcuts') ||
          screen.includes('Ctrl-C') ||
          screen.includes('Claude Code') ||
          screen.includes('exit') ||
          screen.includes('Try'),
      ).toBe(true)
    })
  })
})
