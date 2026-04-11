/**
 * Plan Mode E2E Tests
 *
 * Tests plan mode transitions and the scroll re-pinning fix that prevents
 * blank screen after clearing context (similar to the /clear fix in
 * commit 26bc15d but extended to the plan mode clear-context path).
 */

import {
  describe,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  test,
  setDefaultTimeout,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep } from './tmux-helpers'

setDefaultTimeout(120_000)

// Generate a long text block to fill the terminal screen
function longText(label: string, lines = 30): string {
  return Array.from(
    { length: lines },
    (_, i) => `${label} line ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
  ).join('\n')
}

describe('Plan Mode E2E', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  describe('Scroll pinning after /clear', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('screen is not blank after /clear with long conversation history', async () => {
      // Build up a long conversation, then /clear and send a new prompt.
      // The /clear path uses clearConversation which resets messages and
      // bumps conversationId. The scroll must be re-pinned so the new
      // response is visible (not blank).
      server.reset([
        textResponse(longText('Response-1', 30)),
        textResponse(longText('Response-2', 30)),
        textResponse(longText('Response-3', 30)),
        // Response after /clear + new prompt
        textResponse('POST_CLEAR_VISIBLE: This response should be visible after clearing.'),
      ])

      session = new TmuxSession({
        serverUrl: server.url,
        height: 40,
        width: 120,
        additionalEnv: {
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
        },
      })
      await session.start()

      // Build up conversation history
      await session.submitAndWaitForResponse('First prompt')
      await sleep(300)
      await session.submitAndWaitForResponse('Second prompt')
      await sleep(300)
      await session.submitAndWaitForResponse('Third prompt')
      await sleep(300)

      // /clear resets the conversation
      await session.sendLine('/clear')
      await sleep(2000)

      // Send a new prompt after clearing
      const screen = await session.submitAndWaitForResponse('Post-clear prompt')

      expect(screen).toContain('POST_CLEAR_VISIBLE')

      // CRITICAL: Check the current viewport is not blank
      const currentPane = await session.capturePane()
      const nonEmptyLines = currentPane
        .split('\n')
        .filter(line => line.trim().length > 0)
      expect(nonEmptyLines.length).toBeGreaterThan(3)
      expect(currentPane).toContain('POST_CLEAR_VISIBLE')
    })
  })

  describe('Plan mode approval', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('screen is not blank after plan mode approval (keep context)', async () => {
      // Test the plan mode approval flow without clear context.
      // EnterPlanMode is auto-approved, ExitPlanMode shows a dialog.
      // Selecting "Yes" keeps context and continues.
      server.reset([
        textResponse(longText('Response-1', 25)),
        textResponse(longText('Response-2', 25)),
        toolUseResponse([{ name: 'EnterPlanMode', input: {} }]),
        toolUseResponse(
          [{ name: 'ExitPlanMode', input: {} }],
          'Here is my implementation plan.',
        ),
        // After ExitPlanMode is approved (keep context), the tool runs
        // and returns a result. The model responds to the tool result.
        textResponse('PLAN_APPROVED_VISIBLE: Now implementing the plan.'),
      ])

      session = new TmuxSession({
        serverUrl: server.url,
        height: 40,
        width: 120,
        additionalEnv: {
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
        },
      })
      await session.start()

      // Build conversation history
      await session.submitAndWaitForResponse('First prompt')
      await sleep(300)
      await session.submitAndWaitForResponse('Second prompt')
      await sleep(300)

      // Trigger plan mode
      await session.sendLine('Please plan something')
      await sleep(1000)

      // Wait for the ExitPlanMode dialog
      await session.waitForText('Exit plan mode', 30_000)
      await sleep(500)

      // Select "Yes" (first option - keep context, approve)
      await session.sendSpecialKey('Enter')

      // Wait for the response after plan approval
      const screen = await session.waitForText('PLAN_APPROVED_VISIBLE', 30_000)
      expect(screen).toContain('PLAN_APPROVED_VISIBLE')

      // CRITICAL: Check the current viewport is not blank
      const currentPane = await session.capturePane()
      // biome-ignore lint/suspicious/noConsole: debug output
      console.log('=== Pane after plan approval ===')
      // biome-ignore lint/suspicious/noConsole: debug output
      console.log(currentPane)

      const nonEmptyLines = currentPane
        .split('\n')
        .filter(line => line.trim().length > 0)
      expect(nonEmptyLines.length).toBeGreaterThan(3)
      expect(currentPane).toContain('PLAN_APPROVED_VISIBLE')
    })
  })
})
