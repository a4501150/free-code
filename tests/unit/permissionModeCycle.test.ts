/**
 * The Shift+Tab permission-mode cycle: bypassPermissions is part of it
 * without a launch flag — the keypress is itself a deliberate user action —
 * while the settings kill-switch (disableBypassPermissionsMode) still wins.
 *
 * The kill-switch is exercised through a real temp config home rather than
 * mock.module: permissionSetup imports the settings module at load time, and
 * a module mock does not rebind an already-imported namespace in the shared
 * unit-test process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PermissionMode } from '../../src/utils/permissions/PermissionMode.js'

const { getNextPermissionMode, cyclePermissionMode } =
  await import('../../src/utils/permissions/getNextPermissionMode.js')
const { resetSettingsCache } =
  await import('../../src/utils/settings/settingsCache.js')
const { transitionPermissionMode } =
  await import('../../src/utils/permissions/permissionSetup.js')

function ctx(
  mode: PermissionMode,
  overrides: Record<string, unknown> = {},
): Parameters<typeof getNextPermissionMode>[0] {
  return {
    mode,
    isBypassPermissionsModeAvailable: false,
    isAutoModeAvailable: false,
    ...overrides,
  } as Parameters<typeof getNextPermissionMode>[0]
}

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'permission-mode-cycle-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  resetSettingsCache()
})

afterEach(async () => {
  delete process.env.FREECODE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  resetSettingsCache()
})

describe('getNextPermissionMode cycle', () => {
  test('cycles into bypass from plan without a launch flag', () => {
    expect(getNextPermissionMode(ctx('default'))).toBe('acceptEdits')
    expect(getNextPermissionMode(ctx('acceptEdits'))).toBe('plan')
    expect(getNextPermissionMode(ctx('plan'))).toBe('bypassPermissions')
  })

  test('cycles out of bypass to default when auto is unavailable', () => {
    expect(getNextPermissionMode(ctx('bypassPermissions'))).toBe('default')
  })

  test('settings kill-switch skips bypass in the cycle', async () => {
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'freecode.json'),
      JSON.stringify({
        permissions: { disableBypassPermissionsMode: 'disable' },
      }),
    )
    resetSettingsCache()
    expect(getNextPermissionMode(ctx('plan'))).toBe('default')
  })

  test('cyclePermissionMode prepares the transition to bypass', () => {
    const { nextMode, context } = cyclePermissionMode(ctx('plan'))
    expect(nextMode).toBe('bypassPermissions')
    // Entering bypass without the launch flag must still look
    // bypass-capable: the live settings-change kick-out and the SDK
    // set_permission_mode gate read this flag.
    expect(context.isBypassPermissionsModeAvailable).toBe(true)
    // The side-effect carrier must accept plan→bypass directly (restores
    // anything plan mode stripped, records hasExitedPlanMode).
    expect(() =>
      transitionPermissionMode('plan', 'bypassPermissions', ctx('plan')),
    ).not.toThrow()
  })
})
