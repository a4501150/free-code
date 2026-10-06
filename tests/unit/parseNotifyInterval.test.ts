import { describe, expect, test } from 'bun:test'
import {
  NOTIFY_INTERVAL_FORMATS,
  parseNotifyIntervalMs,
} from 'src/utils/parseNotifyInterval.js'

describe('parseNotifyIntervalMs', () => {
  test('parses each unit', () => {
    expect(parseNotifyIntervalMs('30s')).toBe(30_000)
    expect(parseNotifyIntervalMs('5m')).toBe(300_000)
    expect(parseNotifyIntervalMs('1h')).toBe(3_600_000)
  })

  test('parses decimals', () => {
    expect(parseNotifyIntervalMs('1.5h')).toBe(5_400_000)
    expect(parseNotifyIntervalMs('0.5s')).toBe(500)
  })

  test('trims whitespace', () => {
    expect(parseNotifyIntervalMs(' 5m ')).toBe(300_000)
  })

  test('rejects invalid forms', () => {
    expect(parseNotifyIntervalMs('every minute')).toBeUndefined()
    expect(parseNotifyIntervalMs('5')).toBeUndefined()
    expect(parseNotifyIntervalMs('m')).toBeUndefined()
    expect(parseNotifyIntervalMs('1m30s')).toBeUndefined()
    expect(parseNotifyIntervalMs('1w')).toBeUndefined()
    expect(parseNotifyIntervalMs('')).toBeUndefined()
  })

  test('rejects non-positive numbers', () => {
    expect(parseNotifyIntervalMs('0s')).toBeUndefined()
    expect(parseNotifyIntervalMs('-5m')).toBeUndefined()
  })

  test('formats doc lists valid forms', () => {
    expect(NOTIFY_INTERVAL_FORMATS).toContain('s, m, or h')
  })
})
