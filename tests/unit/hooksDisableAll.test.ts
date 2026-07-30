/**
 * `disableAllHooks` must suppress every hook channel, not just settings-defined
 * hooks. Plugin-registered and session-derived (agent/skill frontmatter) hooks
 * are assembled separately in hooks.ts and are gated on areAllHooksDisabled().
 *
 * This previously rode on the managed-settings helper shouldAllowManagedHooksOnly(),
 * which returned true whenever a non-managed source set disableAllHooks. Removing
 * managed settings collapsed the two into this one predicate; these tests pin the
 * resulting behavior so the plugin/session gating can't be dropped by accident.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import * as settingsModule from '../../src/utils/settings/settings.js'
import {
  areAllHooksDisabled,
  getHooksConfigFromSnapshot,
  resetHooksConfigSnapshot,
} from '../../src/utils/hooks/hooksConfigSnapshot.js'

const SAMPLE_HOOKS = {
  PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'echo' }] },
  ],
}

function mockSettings(settings: Record<string, unknown>) {
  return spyOn(settingsModule, 'getSettings_DEPRECATED').mockReturnValue(
    settings as never,
  )
}

afterEach(() => {
  resetHooksConfigSnapshot()
})

describe('disableAllHooks', () => {
  test('is false when unset', () => {
    mockSettings({ hooks: SAMPLE_HOOKS })
    expect(areAllHooksDisabled()).toBe(false)
  })

  test('is true when set in merged settings', () => {
    mockSettings({ disableAllHooks: true, hooks: SAMPLE_HOOKS })
    expect(areAllHooksDisabled()).toBe(true)
  })

  test('only an explicit true disables — false and undefined do not', () => {
    mockSettings({ disableAllHooks: false, hooks: SAMPLE_HOOKS })
    expect(areAllHooksDisabled()).toBe(false)
  })

  test('settings hooks load normally when not disabled', () => {
    mockSettings({ hooks: SAMPLE_HOOKS })
    resetHooksConfigSnapshot()
    expect(getHooksConfigFromSnapshot()).toEqual(SAMPLE_HOOKS)
  })

  test('settings hooks are emptied when disabled', () => {
    mockSettings({ disableAllHooks: true, hooks: SAMPLE_HOOKS })
    resetHooksConfigSnapshot()
    expect(getHooksConfigFromSnapshot()).toEqual({})
  })
})
