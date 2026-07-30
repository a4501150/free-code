/**
 * freecode.json / modelSettings.json are separate concerns: general settings vs.
 * model/provider config. Writes are routed by MODEL_SETTINGS_KEYS; these tests
 * pin the matching read-side filter.
 *
 * Without the filter, modelSettings.json merges second and the schema is
 * .passthrough(), so a stray general key there would silently outrank
 * freecode.json.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSettingsForSource } from '../../src/utils/settings/settings.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'

let tmpDir: string
let prevConfigDir: string | undefined

function writeFreecode(json: unknown): void {
  writeFileSync(join(tmpDir, 'freecode.json'), JSON.stringify(json, null, 2))
}

function writeModelSettings(json: unknown): void {
  writeFileSync(
    join(tmpDir, 'modelSettings.json'),
    JSON.stringify(json, null, 2),
  )
}

function readUserSettings() {
  resetSettingsCache()
  return getSettingsForSource('userSettings')
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'settings-split-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
})

afterEach(() => {
  if (prevConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  }
  rmSync(tmpDir, { recursive: true, force: true })
  resetSettingsCache()
})

describe('freecode.json / modelSettings.json read split', () => {
  test('a general key in modelSettings.json does not override freecode.json', () => {
    writeFreecode({ theme: 'dark' })
    writeModelSettings({ theme: 'light' })

    expect(readUserSettings()?.theme).toBe('dark')
  })

  test('a general key present only in modelSettings.json is ignored', () => {
    writeFreecode({})
    writeModelSettings({ theme: 'light' })

    expect(readUserSettings()?.theme).toBeUndefined()
  })

  test('model keys are read from modelSettings.json', () => {
    writeFreecode({ theme: 'dark' })
    writeModelSettings({ defaultModel: 'anthropic:claude-opus-4-6' })

    const settings = readUserSettings()
    expect(settings?.defaultModel).toBe('anthropic:claude-opus-4-6')
    expect(settings?.theme).toBe('dark')
  })

  test('a model key in modelSettings.json wins over the same key in freecode.json', () => {
    writeFreecode({ defaultModel: 'anthropic:legacy' })
    writeModelSettings({ defaultModel: 'anthropic:claude-opus-4-6' })

    expect(readUserSettings()?.defaultModel).toBe('anthropic:claude-opus-4-6')
  })

  test('a model key present only in freecode.json still resolves', () => {
    writeFreecode({ defaultModel: 'anthropic:legacy' })
    writeModelSettings({})

    expect(readUserSettings()?.defaultModel).toBe('anthropic:legacy')
  })

  test('an invalid general key in modelSettings.json does not drop its model keys', () => {
    writeFreecode({})
    // `permissions` must be an object; a string fails schema validation. It is
    // filtered out before merging, so defaultModel must survive.
    writeModelSettings({
      permissions: 'not-an-object',
      defaultModel: 'anthropic:claude-opus-4-6',
    })

    expect(readUserSettings()?.defaultModel).toBe('anthropic:claude-opus-4-6')
  })

  test('providers are read from modelSettings.json', () => {
    writeFreecode({ theme: 'dark' })
    writeModelSettings({
      providers: {
        anthropic: {
          type: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          models: [{ id: 'claude-opus-4-6' }],
        },
      },
    })

    const providers = readUserSettings()?.providers as
      | Record<string, unknown>
      | undefined
    expect(providers?.anthropic).toBeTruthy()
  })
})
