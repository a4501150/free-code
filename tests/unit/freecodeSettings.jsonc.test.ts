/**
 * Integration tests: freecode.json JSONC round-trip.
 *
 * Exercises the real `readFreecodeSettingsFile` + `writeFreecodeSettingsFile`
 * functions against a temp `CLAUDE_CONFIG_DIR`. freecode.json holds general
 * settings (autoMode, mcpServers, permissions, etc.); provider/model config
 * lives in modelSettings.json (see modelSettings.jsonc.test.ts).
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
  "mcpServers": {
    // keep local-tools untouched
    "local-tools": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"]
    },
    "remote-tools": {
      "url": "https://mcp.example.com"
    }
  },
  /* auto mode comment */
  "autoMode": { "enabled": true }
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
    expect(parsed?.autoMode).toEqual({ enabled: true })
    const mcpServers = parsed?.mcpServers as Record<string, unknown>
    expect(Object.keys(mcpServers).sort()).toEqual([
      'local-tools',
      'remote-tools',
    ])
  })

  test('writeFreecodeSettingsFile updating one mcpServer preserves comments on siblings', () => {
    const path = join(tmpDir, 'freecode.json')
    writeFileSync(path, SEEDED)

    writeFreecodeSettingsFile({
      mcpServers: {
        'remote-tools': {
          url: 'https://mcp-v2.example.com',
          headers: { Authorization: 'Bearer tok' },
        },
      },
    })

    const content = readFileSync(path, 'utf8')
    // Top-level comment survives
    expect(content).toContain('// user-authored top comment')
    // Sibling server's comment survives
    expect(content).toContain('// keep local-tools untouched')
    // Sibling server's body is byte-identical
    expect(content).toContain('"my-mcp-server"')
    // Unrelated top-level key's comment survives
    expect(content).toContain('/* auto mode comment */')
    expect(content).toContain('"enabled": true')
    // New server content is written
    expect(content).toContain('mcp-v2.example.com')

    // Parsed form is correct
    const reparsed = readFreecodeSettingsFile()
    const servers = reparsed?.mcpServers as Record<
      string,
      Record<string, unknown>
    >
    expect(servers['local-tools']).toEqual({
      command: 'npx',
      args: ['-y', 'my-mcp-server'],
    })
    expect(servers['remote-tools']).toMatchObject({
      url: 'https://mcp-v2.example.com',
    })
    expect(reparsed?.autoMode).toEqual({ enabled: true })
  })

  test('writeFreecodeSettingsFile updating a scalar leaves the mcpServers block untouched', () => {
    const path = join(tmpDir, 'freecode.json')
    writeFileSync(path, SEEDED)

    writeFreecodeSettingsFile({
      autoMode: { enabled: false, classifierModel: 'anthropic:claude-haiku-4-5' },
    })

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('// user-authored top comment')
    expect(content).toContain('// keep local-tools untouched')
    expect(content).toContain('"remote-tools"')
    // Value updated
    expect(content).toContain('"enabled": false')
    expect(content).toContain('"classifierModel"')
  })

  test('writeFreecodeSettingsFile creates a new file when none exists (no comments to preserve)', () => {
    const path = join(tmpDir, 'freecode.json')
    writeFreecodeSettingsFile({
      autoMode: { enabled: true },
      mcpServers: { tools: { command: 'echo' } },
    })
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('"autoMode"')
    expect(content).toContain('"tools"')
    expect(content.endsWith('\n')).toBe(true)
  })
})
