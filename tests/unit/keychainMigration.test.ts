/**
 * One-shot keychain -> .credentials.json import. The `security` spawn is
 * injected, so these tests never touch the real keychain; the startup
 * wrapper is tested only for its deterministic skip paths (a real import
 * here would depend on the machine's keychain state).
 *
 * NODE_ENV=test makes getGlobalConfig/saveGlobalConfig operate on the
 * in-memory testing singleton — the attempt marker is reset per test by
 * mutating that object directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getGlobalConfig, saveGlobalConfig } from '../../src/utils/config.js'
import {
  importCredentialsFromKeychain,
  KeychainTimeoutError,
  maybeRunKeychainMigrationOnStartup,
  type ExecSecurity,
} from '../../src/utils/secureStorage/keychainMigration.js'

let configDir: string
let prevConfigDir: string | undefined

function storagePath(): string {
  return join(configDir, '.credentials.json')
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'kc-migration-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete (getGlobalConfig() as { keychainMigrationAttemptedAt?: string })
    .keychainMigrationAttemptedAt
})

afterEach(() => {
  if (prevConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

const KEYCHAIN_BLOB = {
  claudeAiOauth: {
    accessToken: 'keychain-token',
    refreshToken: 'keychain-refresh',
    expiresAt: 123,
  },
  oauthAccount: { accountUuid: 'acct-1' },
}

describe('importCredentialsFromKeychain', () => {
  test('imports the blob into a fresh .credentials.json (0600)', () => {
    let seenArgs: string[] | null = null
    const exec: ExecSecurity = args => {
      seenArgs = args
      return JSON.stringify(KEYCHAIN_BLOB)
    }
    const outcome = importCredentialsFromKeychain({ execSecurity: exec })
    expect(outcome).toEqual({
      status: 'imported',
      keys: ['claudeAiOauth', 'oauthAccount'],
    })
    // Credentials service entry (not the legacy no-suffix one).
    expect(seenArgs?.join(' ')).toContain('-credentials')
    const written = JSON.parse(readFileSync(storagePath(), 'utf8'))
    expect(written.claudeAiOauth.accessToken).toBe('keychain-token')
    expect((statSync(storagePath()).mode & 0o777).toString(8)).toBe('600')
  })

  test('merge never clobbers keys already in the plaintext store', () => {
    writeFileSync(
      storagePath(),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'live-token' },
        mcpOAuth: { srv: { accessToken: 'mcp' } },
      }),
    )
    const outcome = importCredentialsFromKeychain({
      execSecurity: () => JSON.stringify(KEYCHAIN_BLOB),
    })
    expect(outcome).toEqual({ status: 'imported', keys: ['oauthAccount'] })
    const written = JSON.parse(readFileSync(storagePath(), 'utf8'))
    expect(written.claudeAiOauth.accessToken).toBe('live-token')
    expect(written.mcpOAuth.srv.accessToken).toBe('mcp')
    expect(written.oauthAccount.accountUuid).toBe('acct-1')
  })

  test('entry absent -> no-entry, file untouched', () => {
    const outcome = importCredentialsFromKeychain({ execSecurity: () => null })
    expect(outcome).toEqual({ status: 'no-entry' })
    expect(existsSync(storagePath())).toBe(false)
  })

  test('timeout surfaces as timeout without throwing', () => {
    const outcome = importCredentialsFromKeychain({
      execSecurity: () => {
        throw new KeychainTimeoutError('timed out')
      },
    })
    expect(outcome).toEqual({ status: 'timeout' })
    expect(existsSync(storagePath())).toBe(false)
  })

  test('non-JSON entry surfaces as malformed', () => {
    const outcome = importCredentialsFromKeychain({
      execSecurity: () => 'not json',
    })
    expect(outcome).toEqual({ status: 'malformed' })
  })
})

describe('maybeRunKeychainMigrationOnStartup', () => {
  test('skips when .credentials.json already exists', () => {
    writeFileSync(storagePath(), '{}')
    expect(maybeRunKeychainMigrationOnStartup()).toBe('skipped-file-present')
    expect(getGlobalConfig().keychainMigrationAttemptedAt).toBeUndefined()
  })

  test('skips once the attempt marker is set (no re-import of stale tokens)', () => {
    saveGlobalConfig(c => ({ ...c, keychainMigrationAttemptedAt: 'now' }))
    expect(maybeRunKeychainMigrationOnStartup()).toBe('skipped-marker')
    expect(existsSync(storagePath())).toBe(false)
  })
})
