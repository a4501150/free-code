/**
 * LogoV2 vertical divider survival E2E test
 *
 * Verifies that the vertical divider between the left and right panels
 * in LogoV2's horizontal layout survives after content pushes it above
 * the ScrollBox viewport and the user scrolls back up.
 *
 * Root cause: the divider used height="100%" which Yoga resolves to 0
 * after the logo subtree is culled by renderScrolledChildren
 * (dropSubtreeCache) and re-enters the viewport. The fix uses
 * minHeight={9} + alignSelf="stretch" for a definite height floor.
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
import { textResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

/**
 * Count lines that have 3+ │ characters — indicating
 * left border + inner divider + right border in horizontal layout.
 * Lines with only 2 │ (left + right border, no divider) don't count.
 */
function countDividerLines(lines: string[]): number {
  return lines.filter(line => {
    const matches = [...line.matchAll(/│/g)]
    return matches.length >= 3
  }).length
}

describe('LogoV2 vertical divider', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  describe('Horizontal layout divider', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('divider renders on initial startup', async () => {
      server.reset([])

      // Wide terminal (130 cols) triggers horizontal layout mode.
      // CLAUDE_CODE_FORCE_FULL_LOGO=true forces the full logo.
      session = new TmuxSession({
        serverUrl: server.url,
        width: 130,
        height: 40,
        additionalEnv: {
          CLAUDE_CODE_FORCE_FULL_LOGO: 'true',
        },
      })
      await session.start()

      const screen = await session.capturePane()
      const logoLines = screen.split('\n').slice(0, 15)
      expect(countDividerLines(logoLines)).toBeGreaterThanOrEqual(3)
    })

    test('divider survives after scrolling out and back into viewport', async () => {
      // Long response pushes logo above the ScrollBox viewport.
      // Then Page Up scrolls back to reveal the logo.
      const longResponse = Array.from(
        { length: 50 },
        (_, i) => `${i + 1}`,
      ).join('\n')

      server.reset([textResponse(longResponse)])

      session = new TmuxSession({
        serverUrl: server.url,
        width: 130,
        height: 40,
        additionalEnv: {
          CLAUDE_CODE_FORCE_FULL_LOGO: 'true',
        },
      })
      await session.start()

      // Verify divider present initially
      let screen = await session.capturePane()
      let logoLines = screen.split('\n').slice(0, 15)
      expect(countDividerLines(logoLines)).toBeGreaterThanOrEqual(3)

      // Send prompt — response will push logo above viewport
      await session.sendLine('count')
      await session.waitForPrompt(15_000)

      // Logo should be scrolled out of view now
      screen = await session.capturePane()
      // First line should NOT be the logo border
      expect(screen.split('\n')[0]).not.toContain('╭')

      // Scroll back up to reveal logo
      await session.sendSpecialKey('PPage')
      await sleep(500)
      await session.sendSpecialKey('PPage')
      await sleep(500)
      await session.sendSpecialKey('PPage')
      await sleep(500)

      // Verify divider is still present after re-entering viewport
      screen = await session.capturePane()
      logoLines = screen.split('\n').slice(0, 15)
      const dividerCount = countDividerLines(logoLines)

      // The divider should be visible on multiple rows.
      // Before the fix (height="100%"), this was 0 because Yoga
      // resolved the height to 0 after the subtree was culled.
      expect(dividerCount).toBeGreaterThanOrEqual(3)
    })
  })
})
