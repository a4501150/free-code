import { describe, expect, test } from 'bun:test'
import { isJumpToBottomVisible } from '../../src/components/FullscreenLayout.js'
import type { ScrollBoxHandle } from '../../src/ink/components/ScrollBox.js'

function handle(state: {
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
  sticky?: boolean
  pendingDelta?: number
}): ScrollBoxHandle {
  return {
    getScrollTop: () => state.scrollTop,
    getPendingDelta: () => state.pendingDelta ?? 0,
    getScrollHeight: () => state.scrollHeight,
    getViewportHeight: () => state.viewportHeight,
    isSticky: () => state.sticky ?? false,
  } as unknown as ScrollBoxHandle
}

describe('isJumpToBottomVisible', () => {
  test('hidden while pinned (no divider snapshot)', () => {
    expect(
      isJumpToBottomVisible(
        handle({ scrollTop: 900, scrollHeight: 1000, viewportHeight: 100 }),
        null,
      ),
    ).toBe(false)
  })

  test('shown when the viewport bottom is above the divider', () => {
    expect(
      isJumpToBottomVisible(
        handle({ scrollTop: 400, scrollHeight: 1000, viewportHeight: 100 }),
        1000,
      ),
    ).toBe(true)
  })

  test('hidden once the viewport bottom reaches the divider', () => {
    expect(
      isJumpToBottomVisible(
        handle({ scrollTop: 900, scrollHeight: 1000, viewportHeight: 100 }),
        1000,
      ),
    ).toBe(false)
  })

  test('pending wheel delta counts toward the viewport bottom', () => {
    expect(
      isJumpToBottomVisible(
        handle({
          scrollTop: 400,
          pendingDelta: 500,
          scrollHeight: 1000,
          viewportHeight: 100,
        }),
        1000,
      ),
    ).toBe(false)
  })

  test('hidden while sticky even if the divider is out of reach', () => {
    expect(
      isJumpToBottomVisible(
        handle({
          scrollTop: 0,
          scrollHeight: 700,
          viewportHeight: 100,
          sticky: true,
        }),
        1000,
      ),
    ).toBe(false)
  })

  test('a divider past a shrunken content height still resolves at the bottom', () => {
    // Content measured SHORTER than when the divider was snapshotted, so the
    // reachable bottom (600) never reaches dividerY (1000). Unclamped, the
    // pill would be stuck on screen forever.
    expect(
      isJumpToBottomVisible(
        handle({ scrollTop: 600, scrollHeight: 700, viewportHeight: 100 }),
        1000,
      ),
    ).toBe(false)
    expect(
      isJumpToBottomVisible(
        handle({ scrollTop: 200, scrollHeight: 700, viewportHeight: 100 }),
        1000,
      ),
    ).toBe(true)
  })
})
