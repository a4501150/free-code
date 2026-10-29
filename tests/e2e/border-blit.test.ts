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

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
import { textResponse } from '../helpers/fixture-builders'
import { loadScaledTimeoutMs } from '../helpers/wait-helpers'
import {
  type TmuxSession,
  createLoggingTest,
  setupE2ESuite,
} from './tmux-helpers'

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
  const { server, startSession } = setupE2ESuite()

  describe('Horizontal layout divider', () => {
    let session: TmuxSession

    test('divider renders on initial startup', async () => {
      server.reset([])

      // Wide terminal (130 cols) triggers horizontal layout mode.
      // CLAUDE_CODE_FORCE_FULL_LOGO=true forces the full logo.
      session = await startSession({
        width: 130,
        height: 40,
        additionalEnv: {
          CLAUDE_CODE_FORCE_FULL_LOGO: 'true',
        },
      })

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

      session = await startSession({
        width: 130,
        height: 40,
        additionalEnv: {
          CLAUDE_CODE_FORCE_FULL_LOGO: 'true',
        },
      })

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

      // Scroll back up until the logo reaches the top of the pane. The
      // number of pages depends on how much of the response rendered, so a
      // fixed press count can land one page short; keep pressing until the
      // logo's top border appears in the captured rows.
      //
      // A press must never happen while the logo is already at the top:
      // sendKeyAndAwaitRender throws when a key changes nothing, and PPage
      // at the top of the scroll region is exactly such a no-op. A transient
      // repaint (spinner/status frame) between a scroll landing and the
      // post-press check once ordered one press too many — a 10s hang on a
      // no-op, not a paint failure. So: check BEFORE each press, and treat a
      // timed-out press as "the view is already at top" — the visibility
      // check below then decides success or failure on the settled screen.
      const maxScrollBackPresses = 10
      for (let i = 0; i < maxScrollBackPresses; i++) {
        screen = await session.capturePane()
        logoLines = screen.split('\n').slice(0, 15)
        if (logoLines.some(line => line.includes('╭'))) break

        try {
          await session.sendKeyAndAwaitRender(
            'PPage',
            loadScaledTimeoutMs(10_000),
          )
        } catch {
          // The press changed nothing: at top (or the region is
          // exhausted). Stop pressing either way — the logo is either on
          // this settled screen or the divider genuinely did not survive.
          screen = await session.capturePane()
          logoLines = screen.split('\n').slice(0, 15)
          break
        }
      }

      // Verify divider is still present after re-entering viewport
      const dividerCount = countDividerLines(logoLines)

      // The divider should be visible on multiple rows.
      // Before the fix (height="100%"), this was 0 because Yoga
      // resolved the height to 0 after the subtree was culled.
      expect(dividerCount).toBeGreaterThanOrEqual(3)
    })
  })
})
