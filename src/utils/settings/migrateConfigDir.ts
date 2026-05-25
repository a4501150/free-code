/**
 * Config directory migration between ~/.claude and ~/.freecode.
 *
 * Centralises the copy logic used by:
 *   - Interactive setup prompt (interactiveHelpers.tsx)
 *   - Headless auto-migration (main.tsx preAction)
 *   - `claude migrate-config` CLI subcommand
 *
 * No circular deps — only uses fs, path, os, and envUtils.
 */

import { cpSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { writeFreecodeSettingsFile } from './freecodeSettings.js'

export function getFreecodeConfigDir(): string {
  return join(homedir(), '.freecode')
}

export function getLegacyClaudeConfigDir(): string {
  return join(homedir(), '.claude')
}

/**
 * True when ~/.freecode/ does not exist, ~/.claude/ does, and no env-var
 * override is active. In this state the user should be offered (or
 * automatically given) a migration.
 */
export function needsConfigDirMigration(): boolean {
  return (
    !existsSync(getClaudeConfigHomeDir()) &&
    existsSync(getLegacyClaudeConfigDir()) &&
    !process.env.FREECODE_CONFIG_DIR &&
    !process.env.CLAUDE_CONFIG_DIR
  )
}

/**
 * Copy one config directory to another. Used for both directions.
 * Returns the (src, dst) pair that was used.
 */
export function copyConfigDir(
  src: string,
  dst: string,
): { src: string; dst: string } {
  cpSync(src, dst, { recursive: true })
  return { src, dst }
}

/**
 * Migrate ~/.claude/ → ~/.freecode/.
 * Precondition: caller has verified `needsConfigDirMigration()` or equivalent.
 */
export function migrateToFreecodeDir(): void {
  copyConfigDir(getLegacyClaudeConfigDir(), getClaudeConfigHomeDir())
}

/**
 * Path to the legacy ~/.claude.json global config file.
 */
function getLegacyGlobalConfigPath(): string {
  return join(
    process.env.FREECODE_CONFIG_DIR ||
      process.env.CLAUDE_CONFIG_DIR ||
      homedir(),
    '.claude.json',
  )
}

/**
 * True when ~/.claude.json exists and freecode.json has no `state` key yet.
 */
export function needsGlobalConfigMigration(): boolean {
  if (!existsSync(getLegacyGlobalConfigPath())) return false
  const freecodeJsonPath = join(getClaudeConfigHomeDir(), 'freecode.json')
  if (!existsSync(freecodeJsonPath)) return true
  try {
    const content = readFileSync(freecodeJsonPath, 'utf8')
    const parsed = safeParseJSON(content)
    if (!parsed || typeof parsed !== 'object') return true
    return !('state' in (parsed as Record<string, unknown>))
  } catch {
    return true
  }
}

/**
 * One-time migration of state fields from ~/.claude.json into
 * freecode.json's `state` key.
 *
 * Migrates: projects, userID, firstStartTime, oauthAccount, companion,
 * companionMuted, customApiKeyResponses.
 *
 * Does NOT migrate mcpServers (already handled by settings migration).
 */
export function migrateGlobalConfigToState(): void {
  const legacyPath = getLegacyGlobalConfigPath()
  if (!existsSync(legacyPath)) return

  let legacy: Record<string, unknown>
  try {
    const content = readFileSync(legacyPath, 'utf8')
    const parsed = safeParseJSON(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    legacy = parsed as Record<string, unknown>
  } catch {
    return
  }

  const STATE_KEYS = [
    'projects',
    'userID',
    'firstStartTime',
    'oauthAccount',
    'companion',
    'companionMuted',
    'customApiKeyResponses',
  ] as const

  const state: Record<string, unknown> = {}
  for (const key of STATE_KEYS) {
    if (key in legacy && legacy[key] !== undefined) {
      state[key] = legacy[key]
    }
  }

  if (Object.keys(state).length === 0) return

  writeFreecodeSettingsFile({ state })
}
