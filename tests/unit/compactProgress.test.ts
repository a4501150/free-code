import { describe, expect, test } from 'bun:test'
import { compactProgressPercent } from '../../src/components/Spinner/compactProgress.js'

describe('compactProgressPercent', () => {
  test('starts at zero', () => {
    expect(compactProgressPercent(0)).toBe(0)
  })

  test('follows the exponential curve', () => {
    expect(compactProgressPercent(10_000)).toBe(11)
    expect(compactProgressPercent(30_000)).toBe(28)
    expect(compactProgressPercent(60_000)).toBe(49)
    expect(compactProgressPercent(90_000)).toBe(63)
  })

  test('caps at 95 so it never reads as finished', () => {
    expect(compactProgressPercent(10 * 60_000)).toBe(95)
    expect(compactProgressPercent(Number.MAX_SAFE_INTEGER)).toBe(95)
  })

  test('never regresses as time advances', () => {
    let previous = -1
    for (let ms = 0; ms <= 600_000; ms += 500) {
      const current = compactProgressPercent(ms)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  test('clamps a negative elapsed time to zero', () => {
    // Clock skew across a suspend/resume must not produce a negative bar.
    expect(compactProgressPercent(-5_000)).toBe(0)
  })
})
