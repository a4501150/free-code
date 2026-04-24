/**
 * Integration tests: freecode.json JSONC round-trip.
 *
 * Exercises the real `readFreecodeSettingsFile` + `writeFreecodeSettingsFile`
 * functions against a temp `CLAUDE_CONFIG_DIR`. Mirrors what the CLI does
 * during routine writes (OAuth refresh, model picker) and confirms that
 * user-authored JSONC comments survive.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  readFreecodeSettingsFile,
  writeFreecodeSettingsFile,
} from '../../src/utils/settings/freecodeSettings.js'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'freecode-jsonc-'))
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

describe('freecode.json JSONC round-trip', () => {
  test('readFreecodeSettingsFile parses a JSONC file with comments', () => {
    writeFileSync(join(tmpDir, 'freecode.json'), SEEDED)
    const parsed = readFreecodeSettingsFile()
    expect(parsed).toBeTruthy()
    expect(parsed?.defaultModel).toBe('anthropic:claude-opus-4-6')
    const providers = parsed?.providers as Record<string, unknown>
    expect(Object.keys(providers).sort()).toEqual(['anthropic', 'claude-ai'])
  })

  test('writeFreecodeSettingsFile updating one provider preserves comments on siblings', () => {
    const path = join(tmpDir, 'freecode.json')
    writeFileSync(path, SEEDED)

    // Simulate what the OAuth refresh / /login flow does.
    writeFreecodeSettingsFile({
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
    // Top-level comment survives
    expect(content).toContain('// user-authored top comment')
    // Sibling provider's comment survives
    expect(content).toContain('// keep anthropic untouched')
    // Sibling provider's body is byte-identical
    expect(content).toContain('"baseUrl": "https://api.anthropic.com"')
    // Unrelated top-level key's comment survives
    expect(content).toContain('/* default model comment */')
    expect(content).toContain('"anthropic:claude-opus-4-6"')
    // New provider content is written
    expect(content).toContain('"accessToken": "new-tok"')

    // Parsed form is correct
    const reparsed = readFreecodeSettingsFile()
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

  test('writeFreecodeSettingsFile updating a scalar leaves the providers block untouched', () => {
    const path = join(tmpDir, 'freecode.json')
    writeFileSync(path, SEEDED)

    // Simulate model picker.
    writeFreecodeSettingsFile({ defaultModel: 'anthropic:claude-haiku-4-5' })

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('// user-authored top comment')
    expect(content).toContain('// keep anthropic untouched')
    expect(content).toContain('"claude-ai"')
    // Value updated
    expect(content).toContain('"anthropic:claude-haiku-4-5"')
    expect(content).not.toContain('"anthropic:claude-opus-4-6"')
  })

  test('writeFreecodeSettingsFile creates a new file when none exists (no comments to preserve)', () => {
    const path = join(tmpDir, 'freecode.json')
    writeFreecodeSettingsFile({
      defaultModel: 'x',
      providers: { anthropic: { type: 'anthropic' } },
    })
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('"defaultModel": "x"')
    expect(content).toContain('"anthropic"')
    expect(content.endsWith('\n')).toBe(true)
  })
})
