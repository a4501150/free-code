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

import { cpSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'

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
