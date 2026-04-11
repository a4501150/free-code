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
        textResponse(longText('Response-1', 50)),
        textResponse(longText('Response-2', 50)),
        textResponse(longText('Response-3', 50)),
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
        textResponse(longText('Response-1', 50)),
        textResponse(longText('Response-2', 50)),
        textResponse(longText('Response-3', 50)),
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

      // Build up enough conversation history to fill 3+ screens.
      // The blank screen bug requires significant virtual scroll content.
      await session.submitAndWaitForResponse('First prompt')
      await sleep(300)
      await session.submitAndWaitForResponse('Second prompt')
      await sleep(300)
      await session.submitAndWaitForResponse('Third prompt')
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
      const nonEmptyLines = currentPane
        .split('\n')
        .filter(line => line.trim().length > 0)
      expect(nonEmptyLines.length).toBeGreaterThan(3)
      expect(currentPane).toContain('PLAN_APPROVED_VISIBLE')
    })

    test('screen is not blank after plan mode approval (clear context)', async () => {
      // Test the plan mode approval flow WITH clear context.
      // This exercises the code path in processInitialMessage where
      // clearContext=true and planContent is set, routing through onQuery
      // (not onSubmit). The deferred setTimeout(repinScroll, 0) after
      // onQuery is the sole re-pin for this path.
      //
      // The blank screen bug requires significant content in the virtual
      // scroll so the height cache has many entries. When conversationId
      // bumps and the cache is invalidated, stale scrollTop overshoots
      // the new (empty) offset range → blank. We use 3+ screens of
      // content to reproduce reliably.
      //
      // The real plan flow: model calls EnterPlanMode, the plan_mode
      // attachment tells the model the plan file path (random slug),
      // the model uses Write to create the plan file, then calls
      // ExitPlanMode. The ExitPlanMode dialog reads the plan from disk.
      //
      // To reproduce: we queue EnterPlanMode first, wait for it, then
      // discover the plan file path from the mock server's request log
      // (the plan_mode attachment contains the path). We write the plan
      // file from the test process, then queue the remaining responses.

      session = new TmuxSession({
        serverUrl: server.url,
        height: 40,
        width: 120,
        settings: { showClearContextOnPlanAccept: true },
        additionalEnv: {
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
        },
      })
      await session.start()

      // Phase 1: Build conversation history and enter plan mode.
      // Queue responses up to and including EnterPlanMode, plus a
      // placeholder text response so the model "continues in plan mode".
      server.reset([
        textResponse(longText('Response-1', 50)),
        textResponse(longText('Response-2', 50)),
        textResponse(longText('Response-3', 50)),
        toolUseResponse([{ name: 'EnterPlanMode', input: {} }]),
        // After EnterPlanMode, the model "plans" — this text response
        // triggers another API call whose request contains the plan_mode
        // attachment with the plan file path.
        textResponse('I have analyzed the codebase and will now write my plan.'),
      ])

      await session.submitAndWaitForResponse('First prompt')
      await sleep(300)
      await session.submitAndWaitForResponse('Second prompt')
      await sleep(300)
      await session.submitAndWaitForResponse('Third prompt')
      await sleep(300)

      // Trigger plan mode — EnterPlanMode is auto-approved, then the text
      // response comes back. In plan mode, the prompt shows "plan mode on"
      // instead of "for shortcuts", so we can't use submitAndWaitForResponse.
      await session.sendLine('Please plan something')
      await session.waitForText('write my plan', 30_000)
      await sleep(1000)

      // Phase 2: Discover the plan file path from the API request log.
      // The plan_mode attachment includes planFilePath in its text.
      const requestLog = server.getRequestLog()
      let planFilePath = ''
      for (const entry of requestLog) {
        const body = JSON.stringify(entry.body)
        // The plan_mode attachment text contains the plan file path
        const match = body.match(/plans\/[a-z]+-[a-z]+-[a-z]+\.md/)
        if (match) {
          const { join } = await import('node:path')
          planFilePath = join(session.configDirPath!, match[0])
          break
        }
      }

      if (!planFilePath) {
        // Fallback: scan the plans directory for the slug
        const { readdirSync } = await import('node:fs')
        const { join } = await import('node:path')
        const plansDir = join(session.configDirPath!, 'plans')
        try {
          const files = readdirSync(plansDir).filter(f => f.endsWith('.md'))
          if (files.length > 0) {
            planFilePath = join(plansDir, files[0]!)
          }
        } catch {
          // Plans directory doesn't exist yet
        }
      }

      // Write the plan file so ExitPlanMode dialog shows full options
      expect(planFilePath).not.toBe('')
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(planFilePath), { recursive: true })
      writeFileSync(planFilePath, '# Plan\n\nStep 1: Implement feature\nStep 2: Add tests\nStep 3: Verify')

      // Phase 3: Queue ExitPlanMode and the post-approval response.
      // After clear-context approval, the plan is sent as a new initial
      // message via onQuery. The ExitPlanMode tool_result is consumed
      // by the original query loop (which gets rejected/cancelled), then
      // the new query starts. Queue extra responses to handle both paths.
      server.reset([
        toolUseResponse(
          [{ name: 'ExitPlanMode', input: {} }],
          'Here is my implementation plan with clear context.',
        ),
        textResponse('CLEAR_CONTEXT_VISIBLE: Implementing after context clear.'),
        textResponse('CLEAR_CONTEXT_VISIBLE: Implementing after context clear.'),
        textResponse('CLEAR_CONTEXT_VISIBLE: Implementing after context clear.'),
        textResponse('CLEAR_CONTEXT_VISIBLE: Implementing after context clear.'),
      ])

      // Send another prompt to trigger ExitPlanMode.
      // Use sendLine which sends text + Enter — the Enter is consumed by the
      // input prompt, not by the upcoming dialog.
      await session.sendLine('Ready to implement')

      // Wait for the ExitPlanMode dialog — should show "Ready to code?"
      // with clear context option since showClearContextOnPlanAccept is true
      await session.waitForText('Ready to code', 30_000)
      await sleep(1000)

      // Select first option — "Yes, clear context and auto-accept edits"
      await session.sendSpecialKey('Enter')

      // Wait for the response after plan approval with cleared context
      const screen = await session.waitForText('CLEAR_CONTEXT_VISIBLE', 30_000)
      expect(screen).toContain('CLEAR_CONTEXT_VISIBLE')

      // CRITICAL: Check the current viewport is not blank
      const currentPane = await session.capturePane()
      const nonEmptyLines = currentPane
        .split('\n')
        .filter(line => line.trim().length > 0)
      expect(nonEmptyLines.length).toBeGreaterThan(3)
      expect(currentPane).toContain('CLEAR_CONTEXT_VISIBLE')
    })
  })
})
