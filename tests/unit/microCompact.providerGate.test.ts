import { describe, expect, test } from 'bun:test'
import { timeBasedClearAllowedForCacheType } from '../../src/services/compact/microCompact.js'

const ON = { enabled: true }

describe('time-based microcompact provider cache gate', () => {
  test('explicit-breakpoint providers clear on idle gap (cache is gone anyway)', () => {
    expect(timeBasedClearAllowedForCacheType('explicit-breakpoint', ON)).toBe(
      true,
    )
  })

  test('automatic-prefix providers skip by default (warm prefix, real miss)', () => {
    expect(timeBasedClearAllowedForCacheType('automatic-prefix', ON)).toBe(
      false,
    )
    expect(
      timeBasedClearAllowedForCacheType('automatic-prefix', {
        ...ON,
        clearOnAutomaticPrefixCache: undefined,
      }),
    ).toBe(false)
  })

  test('automatic-prefix providers clear only with the explicit opt-in', () => {
    expect(
      timeBasedClearAllowedForCacheType('automatic-prefix', {
        ...ON,
        clearOnAutomaticPrefixCache: true,
      }),
    ).toBe(true)
  })

  test('uncached providers clear — every request ships the full prompt anyway', () => {
    expect(timeBasedClearAllowedForCacheType('none', ON)).toBe(true)
  })

  test('the master switch beats everything', () => {
    expect(
      timeBasedClearAllowedForCacheType('explicit-breakpoint', {
        enabled: false,
        clearOnAutomaticPrefixCache: true,
      }),
    ).toBe(false)
  })
})
