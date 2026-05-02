/**
 * REPL E2E Tests
 *
 * Tests the full interactive REPL experience via tmux sessions with a mock
 * Anthropic API server. Covers startup, basic text responses, prompt
 * submission, multi-turn conversations, slash commands, and keyboard input.
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

describe('REPL E2E', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  let session: TmuxSession

  afterEach(async () => {
    if (session) await session.stop()
  })

  // ─── Startup ─────────────────────────────────────────────

  describe('Startup', () => {
    test('shows welcome screen, input prompt, model, and billing info', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const screen = await session.capturePane()

      expect(screen).toContain('Claude Code')
      expect(screen).toContain('Opus')
      expect(screen).toContain('for shortcuts')
      expect(screen).toContain('Opus 4.7')
      expect(screen).toContain('API Usage Billing')
    })
  })

  // ─── Text Responses and Prompt Submission ─────────────────

  describe('Text Responses and Prompt Submission', () => {
    test('renders text responses and returns to the prompt', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      server.reset([textResponse('Hello, world!')])
      await session.sendLine('Say hello')
      let screen = await session.waitForText('Hello, world!', 15_000)
      expect(screen).toContain('Hello, world!')

      const longText =
        'First paragraph with some content.\n\nSecond paragraph with more details.\n\nThird paragraph wrapping up.'
      server.reset([textResponse(longText)])
      await session.sendLine('Write paragraphs')
      await session.waitForText('Third paragraph', 15_000)
      screen = await session.capturePaneWithHistory()
      expect(screen).toContain('First paragraph')
      expect(screen).toContain('Second paragraph')
      expect(screen).toContain('Third paragraph')

      const unicodeText =
        'Symbols: \u2714 \u2718 \u2605 and CJK: \u4F60\u597D\u4E16\u754C'
      server.reset([textResponse(unicodeText)])
      await session.sendLine('Show unicode')
      screen = await session.waitForText('\u4F60\u597D\u4E16\u754C', 15_000)
      expect(screen).toContain('\u4F60\u597D\u4E16\u754C')
      expect(screen).toContain('\u2714')

      const largeText = 'A'.repeat(10_000) + ' END_MARKER'
      server.reset([textResponse(largeText)])
      await session.sendLine('Generate large output')
      screen = await session.waitForText('END_MARKER', 20_000)
      expect(screen).toContain('END_MARKER')

      server.reset([textResponse('Hello from the mock API!')])
      await session.sendLine('Say hello to me')
      screen = await session.waitForText('Hello from the mock API!', 15_000)
      expect(screen).toContain('Hello from the mock API!')

      server.reset([textResponse('Quick response here')])
      await session.sendLine('Quick test')
      await session.waitForText('Quick response here', 15_000)
      await session.waitForPrompt(15_000)
      screen = await session.capturePaneWithHistory()
      expect(screen).toContain('Quick response here')

      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "e2e_tool_test"' } },
        ]),
        textResponse('The command output e2e_tool_test successfully.'),
      ])
      screen = await session.submitAndApprove('Run echo command', 20_000)
      expect(screen).toContain('e2e_tool_test')
    })
  })

  // ─── Multiple Turns ──────────────────────────────────────

  describe('Multiple Turns', () => {
    test('user can submit multiple prompts in one session', async () => {
      server.reset([
        textResponse('First answer: the sky is blue'),
        textResponse('Second answer: water is wet'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.sendLine('What color is the sky?')
      await session.waitForText('First answer', 15_000)
      await session.waitForPrompt(15_000)

      await session.sendLine('What is water?')
      await session.waitForText('Second answer', 15_000)

      const history = await session.capturePaneWithHistory()
      expect(history).toContain('First answer')
      expect(history).toContain('Second answer')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
    })
  })

  // ─── Slash Commands ──────────────────────────────────────

  describe('Slash Commands', () => {
    test('/help and /model render their UI', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.sendLine('/help')
      let screen = await session.waitForText('Shortcuts', 10_000)
      expect(screen).toContain('Shortcuts')
      expect(screen).toContain('bash mode')

      await session.sendLine('/model')
      screen = await session.waitForScreen(
        screen =>
          screen.includes('Sonnet') ||
          screen.includes('Opus') ||
          screen.includes('Haiku') ||
          screen.includes('model'),
        {
          timeoutMs: 10_000,
          description: '/model selector',
          currentPaneOnly: true,
        },
      )
      expect(
        screen.includes('Sonnet') ||
          screen.includes('Opus') ||
          screen.includes('Haiku') ||
          screen.includes('model'),
      ).toBe(true)
    })
  })

  // ─── Keyboard Interaction ────────────────────────────────

  describe('Keyboard Interaction', () => {
    test('Ctrl+C does not crash the REPL', async () => {
      server.reset([])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.sendKeys('partial input')
      await sleep(300)

      await session.sendSpecialKey('C-c')
      await sleep(1500)

      const screen = await session.capturePane()
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
