/**
 * ~/.ripgreprc release: create-if-missing policy, RIPGREP_CONFIG_PATH
 * takeover, and the manageRipgreprc settings opt-out. The target path is
 * injected so the test never writes to the real $HOME; the settings flag
 * is read from a temp config dir (same pattern as settingsFileSplit.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ensureRipgreprcRelease,
  getManageRipgreprc,
  RIPGREPRC_CONTENT,
} from '../../src/utils/ripgreprc.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'

let configDir: string
let targetDir: string
let targetPath: string
let prevConfigDir: string | undefined
let prevRipgrepEnv: string | undefined

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'ripgreprc-cfg-'))
  targetDir = mkdtempSync(join(tmpdir(), 'ripgreprc-home-'))
  targetPath = join(targetDir, '.ripgreprc')
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  prevRipgrepEnv = process.env.RIPGREP_CONFIG_PATH
  delete process.env.RIPGREP_CONFIG_PATH
  resetSettingsCache()
})

afterEach(() => {
  if (prevConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  }
  if (prevRipgrepEnv === undefined) {
    delete process.env.RIPGREP_CONFIG_PATH
  } else {
    process.env.RIPGREP_CONFIG_PATH = prevRipgrepEnv
  }
  rmSync(configDir, { recursive: true, force: true })
  rmSync(targetDir, { recursive: true, force: true })
  resetSettingsCache()
})

function writeUserSettings(json: unknown): void {
  writeFileSync(join(configDir, 'freecode.json'), JSON.stringify(json, null, 2))
  resetSettingsCache()
}

describe('~/.ripgreprc release', () => {
  test('releases the managed globs when the file is missing', () => {
    expect(ensureRipgreprcRelease(targetPath)).toBe(true)
    const content = readFileSync(targetPath, 'utf8')
    expect(content).toBe(RIPGREPRC_CONTENT)
    expect(content).toContain('glob = !node_modules/')
    // Glob lines only: no --pre/--post preprocessor that could execute commands.
    expect(content).not.toMatch(/^[^#]*--pre/)
  })

  test('create-if-missing: an existing file is never modified', () => {
    writeFileSync(targetPath, 'glob = !mine/\n')
    expect(ensureRipgreprcRelease(targetPath)).toBe(false)
    expect(readFileSync(targetPath, 'utf8')).toBe('glob = !mine/\n')
  })

  test('a second release is a no-op', () => {
    expect(ensureRipgreprcRelease(targetPath)).toBe(true)
    expect(ensureRipgreprcRelease(targetPath)).toBe(false)
  })

  test('RIPGREP_CONFIG_PATH takes over: no file is released', () => {
    process.env.RIPGREP_CONFIG_PATH = join(configDir, 'custom-ripgreprc')
    expect(ensureRipgreprcRelease(targetPath)).toBe(false)
    expect(existsSync(targetPath)).toBe(false)
  })

  test('manageRipgreprc: false in freecode.json suppresses the release', () => {
    writeUserSettings({ manageRipgreprc: false })
    expect(getManageRipgreprc()).toBe(false)
    expect(ensureRipgreprcRelease(targetPath)).toBe(false)
    expect(existsSync(targetPath)).toBe(false)
  })

  test('unset flag keeps the release on (default true)', () => {
    writeUserSettings({ theme: 'dark' })
    expect(getManageRipgreprc()).toBe(true)
    expect(ensureRipgreprcRelease(targetPath)).toBe(true)
  })
})
