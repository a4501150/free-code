/**
 * `disableAllHooks` must suppress every hook channel, not just settings-defined
 * hooks. Plugin-registered and session-derived (agent/skill frontmatter) hooks
 * are assembled separately in hooks.ts and are gated on areAllHooksDisabled().
 *
 * Each channel checks areAllHooksDisabled() independently, so dropping the
 * check at any single one silently re-enables that channel. These tests pin
 * the gating so it can't be removed by accident.
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

// Unit tests share one process: an unrestored spy on getSettings_DEPRECATED
// freezes settings for every later test file (tool exposure, catalog, mode
// cycle all read through it), so restore it after each test.
let settingsSpy: ReturnType<typeof spyOn> | undefined

function mockSettings(settings: Record<string, unknown>) {
  settingsSpy = spyOn(settingsModule, 'getSettings_DEPRECATED').mockReturnValue(
    settings as never,
  )
  return settingsSpy
}

afterEach(() => {
  settingsSpy?.mockRestore()
  settingsSpy = undefined
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
