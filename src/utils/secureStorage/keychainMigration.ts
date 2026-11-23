/**
 * One-shot import of credentials from the macOS keychain into the plaintext
 * store (<config home>/.credentials.json) — the ONLY runtime touch point of
 * the `security` CLI in this codebase.
 *
 * Credentials are plaintext-on-every-platform by product decision (see
 * plainTextStorage.ts). The keychain entry is shared with the official
 * Claude Code CLI (same service-name scheme), so this import COPIES — the
 * entry is never written or deleted here, and later freecode re-logins or
 * logouts don't propagate to it either.
 *
 * Every `security` spawn carries a hard timeout: a keychain ACL prompt for
 * an ad-hoc-signed build (or a wedged securityd) used to block startup
 * indefinitely on the un-timed sync fallback — a `cli -p` with a fresh
 * profile sat 19 minutes waiting on it.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { userInfo } from 'os'
import { join } from 'path'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { jsonParse } from '../slowOperations.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorageData } from './types.js'

// Suffix distinguishing the OAuth credentials entry from the legacy no-suffix
// API-key entry (never imported). DO NOT change — part of the keychain
// lookup key shared with the official CLI.
const CREDENTIALS_SERVICE_SUFFIX = '-credentials'

const SECURITY_TIMEOUT_MS = 5_000

export function getMacOsKeychainStorageServiceName(
  serviceSuffix: string = '',
): string {
  const configDir = getClaudeConfigHomeDir()
  const isDefaultDir =
    !process.env.FREECODE_CONFIG_DIR && !process.env.CLAUDE_CONFIG_DIR

  // Hash of the config dir path keeps parallel installs distinguished, but
  // only for non-default dirs (the official CLI's default-dir entry must be
  // found under the plain name).
  const dirHash = isDefaultDir
    ? ''
    : `-${createHash('sha256').update(configDir).digest('hex').substring(0, 8)}`
  return `Claude Code${getOauthConfig().OAUTH_FILE_SUFFIX}${serviceSuffix}${dirHash}`
}

function getUsername(): string {
  try {
    return process.env.USER || userInfo().username
  } catch {
    return 'claude-code-user'
  }
}

export class KeychainTimeoutError extends Error {}

/** Runs `security <args>`; returns stdout, or null when the entry is absent.
 *  Throws KeychainTimeoutError when the spawn hit the hard timeout. */
export type ExecSecurity = (args: string[]) => string | null

function defaultExecSecurity(args: string[]): string | null {
  try {
    const stdout = execFileSync('security', args, {
      encoding: 'utf-8',
      timeout: SECURITY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return stdout.trim() || null
  } catch (e) {
    const err = e as { killed?: boolean; status?: number; signal?: string }
    if (err.killed || (err.signal !== undefined && err.status === undefined)) {
      throw new KeychainTimeoutError('security find-generic-password timed out')
    }
    // Exit 44 (entry not found) and every other failure: no entry to import.
    return null
  }
}

export type KeychainImportOutcome =
  | { status: 'imported'; keys: string[] }
  | { status: 'no-entry' }
  | { status: 'timeout' }
  | { status: 'not-macos' }
  | { status: 'malformed' }
  | { status: 'write-failed' }

/**
 * Reads the credentials keychain entry and merges top-level keys that the
 * plaintext blob doesn't already have (never clobbers live credentials).
 */
export function importCredentialsFromKeychain(deps?: {
  execSecurity?: ExecSecurity
}): KeychainImportOutcome {
  if (process.platform !== 'darwin') return { status: 'not-macos' }
  const exec = deps?.execSecurity ?? defaultExecSecurity
  let stdout: string | null
  try {
    stdout = exec([
      'find-generic-password',
      '-a',
      getUsername(),
      '-w',
      '-s',
      getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
    ])
  } catch (e) {
    if (e instanceof KeychainTimeoutError) return { status: 'timeout' }
    throw e
  }
  if (stdout === null) return { status: 'no-entry' }

  let entry: SecureStorageData
  try {
    const parsed = jsonParse(stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'malformed' }
    }
    entry = parsed as SecureStorageData
  } catch {
    return { status: 'malformed' }
  }

  const existing: SecureStorageData = plainTextStorage.read() ?? {}
  const importedKeys: string[] = []
  for (const [key, value] of Object.entries(entry)) {
    if (existing[key] === undefined) {
      existing[key] = value
      importedKeys.push(key)
    }
  }
  // update() returns {success}, not a boolean — the bare call is always
  // truthy and would misreport a failed write as 'imported'.
  if (importedKeys.length > 0 && !plainTextStorage.update(existing).success) {
    return { status: 'write-failed' }
  }
  return { status: 'imported', keys: importedKeys }
}

export function hasKeychainMigrationBeenAttempted(): boolean {
  return getGlobalConfig().keychainMigrationAttemptedAt !== undefined
}

function markKeychainMigrationAttempted(): void {
  saveGlobalConfig(current =>
    current.keychainMigrationAttemptedAt !== undefined
      ? current
      : { ...current, keychainMigrationAttemptedAt: new Date().toISOString() },
  )
}

/**
 * Startup hook: import once per install. The attempt marker is written even
 * when nothing was found, so a later deleted/revoked .credentials.json never
 * resurrects a stale keychain token.
 */
export function maybeRunKeychainMigrationOnStartup():
  | KeychainImportOutcome
  | 'skipped-marker'
  | 'skipped-file-present' {
  if (process.platform !== 'darwin') return { status: 'not-macos' }
  const storagePath = join(getClaudeConfigHomeDir(), '.credentials.json')
  if (existsSync(storagePath)) return 'skipped-file-present'
  if (hasKeychainMigrationBeenAttempted()) return 'skipped-marker'
  const outcome = importCredentialsFromKeychain()
  markKeychainMigrationAttempted()
  return outcome
}
