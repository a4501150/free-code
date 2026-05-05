import { describe, expect, mock, test } from 'bun:test'

mock.module('../../src/bootstrap/state.js', () => ({
  getAllowedSettingSources: () => [
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ],
}))

const { SettingsSchema } = await import('../../src/utils/settings/types.js')

describe('auto-compact settings schema', () => {
  test('accepts canonical auto-compact settings', () => {
    const result = SettingsSchema().strict().safeParse({
      autoCompactEnabled: true,
      autoCompactPercentage: 100,
      autoCompactBuffer: 20_000,
    })

    expect(result.success).toBe(true)
  })

  test('rejects out-of-range auto-compact percentage', () => {
    expect(
      SettingsSchema().strict().safeParse({ autoCompactPercentage: 9 }).success,
    ).toBe(false)
    expect(
      SettingsSchema().strict().safeParse({ autoCompactPercentage: 101 })
        .success,
    ).toBe(false)
  })

  test('rejects invalid auto-compact buffer', () => {
    expect(
      SettingsSchema().strict().safeParse({ autoCompactBuffer: -1 }).success,
    ).toBe(false)
    expect(
      SettingsSchema().strict().safeParse({ autoCompactBuffer: 1.5 }).success,
    ).toBe(false)
  })
})
