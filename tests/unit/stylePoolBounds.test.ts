/**
 * Unit tests for the StylePool growth bounds (port of official 277 audit
 * item 4, minus the compaction lifecycle — the pool is session-lived
 * because Output.charCache caches interned styleIds across frames).
 *
 * styleId packs into bits [31:17] of a cell's word1 (parity bit included),
 * so past MAX_STYLES unique styles new interning must return `none`
 * (render unstyled) instead of overflowing the field and silently
 * aliasing onto earlier styles with arbitrary colors.
 */

import { describe, expect, test } from 'bun:test'
import type { AnsiCode } from '@alcalzone/ansi-tokenize'
import { StylePool } from '../../src/ink/screen.js'

// 16384 unique truecolor fg codes — enough to reach the 16383 cap plus one.
// The 256/64 split enumerates (r,g) pairs with a fixed-ish b: unique codes.
function uniqueStyles(count: number): AnsiCode[][] {
  const out: AnsiCode[][] = []
  for (let i = 0; i < count; i++) {
    const r = (i >> 8) & 0xff
    const g = i & 0xff
    const b = (i * 7) & 0xff
    out.push([
      {
        code: `\x1b[38;2;${r};${g};${b}m`,
        endCode: '\x1b[39m',
      },
    ])
  }
  return out
}

describe('StylePool bounds', () => {
  test('interning past the 16383-style cap returns none, not an alias', () => {
    const pool = new StylePool()
    const styles = uniqueStyles(16383)
    const ids = styles.map(s => pool.intern(s))
    // All distinct and nonzero: the unstyled slot + 16383 unique styles
    // fill the pool exactly.
    expect(new Set(ids).size).toBe(16383)
    for (const id of ids) expect(id).not.toBe(pool.none)

    // Cap reached: a brand-new style returns none (unstyled) rather than
    // overflowing the packed field, and re-interning a capped-out style
    // does NOT return some other style's id.
    const overflow = pool.intern([
      { code: '\x1b[38;2;255;255;255m', endCode: '\x1b[39m' },
    ])
    expect(overflow).toBe(pool.none)
    expect(pool.get(overflow)).toEqual([])
    // Existing interning still works.
    expect(pool.intern(styles[500]!)).toBe(ids[500])
  })

  test('transition strings stay correct after the cache overflows', () => {
    const pool = new StylePool()
    const styles = uniqueStyles(300)
    const ids = styles.map(s => pool.intern(s))
    const RED = ids[0]!
    const GREEN = ids[1]!
    const expected = pool.transition(RED, GREEN)
    expect(expected.length).toBeGreaterThan(0)
    // Fill the (from,to) cache past its 8192 bound (full-clear on
    // overflow), then check recomputation is identical.
    for (let a = 0; a < 100; a++) {
      for (let b = 0; b < 100; b++) pool.transition(ids[a]!, ids[b]!)
    }
    expect(pool.transition(RED, GREEN)).toBe(expected)
    expect(pool.transition(RED, RED)).toBe('')
  })
})
