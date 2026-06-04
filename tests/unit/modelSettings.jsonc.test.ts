/**
 * Integration tests: modelSettings.json JSONC round-trip.
 *
 * Exercises `readModelSettingsFile` + `writeModelSettingsFile` against a temp
 * `CLAUDE_CONFIG_DIR`. modelSettings.json holds provider/model configuration
 * (providers, defaultModel, model overrides, etc.).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  readModelSettingsFile,
  writeModelSettingsFile,
} from '../../src/utils/settings/modelSettings.js'

const SEEDED = `{
  // user-authored top comment
  "providers": {
    // keep anthropic untouched
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com"
    },
    "claude-ai": {
      "type": "claudeai",
      "auth": { "active": "oauth" }
    }
  },
  /* default model comment */
  "defaultModel": "anthropic:claude-opus-4-6"
}
`

let tmpDir: string
let prevConfigDir: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'model-settings-jsonc-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(() => {
  if (prevConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('modelSettings.json JSONC round-trip', () => {
  test('readModelSettingsFile parses a JSONC file with comments', () => {
    writeFileSync(join(tmpDir, 'modelSettings.json'), SEEDED)
    const parsed = readModelSettingsFile()
    expect(parsed).toBeTruthy()
    expect(parsed?.defaultModel).toBe('anthropic:claude-opus-4-6')
    const providers = parsed?.providers as Record<string, unknown>
    expect(Object.keys(providers).sort()).toEqual(['anthropic', 'claude-ai'])
  })

  test('writeModelSettingsFile updating one provider preserves comments on siblings', () => {
    const path = join(tmpDir, 'modelSettings.json')
    writeFileSync(path, SEEDED)

    writeModelSettingsFile({
      providers: {
        'claude-ai': {
          type: 'claudeai',
          auth: {
            active: 'oauth',
            oauth: { accessToken: 'new-tok', expiresAt: 1234567890 },
          },
        },
      },
    })

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('// user-authored top comment')
    expect(content).toContain('// keep anthropic untouched')
    expect(content).toContain('"baseUrl": "https://api.anthropic.com"')
    expect(content).toContain('/* default model comment */')
    expect(content).toContain('"anthropic:claude-opus-4-6"')
    expect(content).toContain('"accessToken": "new-tok"')

    const reparsed = readModelSettingsFile()
    const providers = reparsed?.providers as Record<
      string,
      Record<string, unknown>
    >
    expect(providers.anthropic).toEqual({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    })
    expect(providers['claude-ai']).toMatchObject({
      type: 'claudeai',
    })
    expect(reparsed?.defaultModel).toBe('anthropic:claude-opus-4-6')
  })

  test('writeModelSettingsFile updating defaultModel leaves the providers block untouched', () => {
    const path = join(tmpDir, 'modelSettings.json')
    writeFileSync(path, SEEDED)

    writeModelSettingsFile({ defaultModel: 'anthropic:claude-haiku-4-5' })

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('// user-authored top comment')
    expect(content).toContain('// keep anthropic untouched')
    expect(content).toContain('"claude-ai"')
    expect(content).toContain('"anthropic:claude-haiku-4-5"')
    expect(content).not.toContain('"anthropic:claude-opus-4-6"')
  })

  test('writeModelSettingsFile creates a new file when none exists', () => {
    const path = join(tmpDir, 'modelSettings.json')
    writeModelSettingsFile({
      defaultModel: 'x',
      providers: { anthropic: { type: 'anthropic' } },
    })
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('"defaultModel": "x"')
    expect(content).toContain('"anthropic"')
    expect(content.endsWith('\n')).toBe(true)
  })

  test('readModelSettingsFile returns null when file does not exist', () => {
    expect(readModelSettingsFile()).toBeNull()
  })
})
