/**
 * Release of search defaults to ~/.ripgreprc.
 *
 * ripgrep auto-loads $HOME/.ripgreprc when RIPGREP_CONFIG_PATH is unset,
 * and a config file's `glob` lines still apply when the caller passes
 * --no-ignore / -u (those flags disable ignore FILES, not explicit
 * globs). Releasing this file makes the big-generated-dir guardrail a
 * floor: an agent that forgets the search convention still gets a fast
 * search, and a later command-line `-g` glob still re-includes a dir on
 * purpose (ripgrep precedence: later globs win).
 *
 * Policy: create-if-missing. An existing file is never modified or
 * re-created after deletion within the same install — user edits are
 * respected, and the settings flag (manageRipgreprc) is the durable
 * opt-out.
 *
 * The released content is glob lines only: a ripgrep config can also
 * smuggle arbitrary command execution via `--pre`, which is why this
 * path sits in DANGEROUS_FILES (permissions/filesystem.ts) and why no
 * preprocessor is ever released here.
 */
import { existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSettingsForSource } from './settings/settings.js'

export const RIPGREPRC_CONTENT = [
  '# free-code: search defaults, auto-loaded by ripgrep. Safe to edit or delete.',
  '# These dirs stay excluded even when --no-ignore drops .gitignore protection.',
  "# Re-include one per search: rg -g 'node_modules/**' PATTERN",
  '# Bypass all lines above: rg --no-config',
  'glob = !node_modules/',
  'glob = !dist/',
  'glob = !target/',
  'glob = !.next/',
  'glob = !.turbo/',
  '',
].join('\n')

/**
 * Default true (opt-out). Returns false if any trusted source explicitly
 * sets false; projectSettings is excluded so a malicious project can't
 * flip the release either way.
 */
export function getManageRipgreprc(): boolean {
  return (
    getSettingsForSource('flagSettings')?.manageRipgreprc !== false &&
    getSettingsForSource('userSettings')?.manageRipgreprc !== false &&
    getSettingsForSource('localSettings')?.manageRipgreprc !== false
  )
}

/**
 * Writes the managed globs to ~/.ripgreprc (`targetPath` in tests),
 * create-if-missing, skipped when RIPGREP_CONFIG_PATH takes over (ripgrep
 * then never reads the default path, so releasing would be dead weight).
 * Returns true only when the file was released.
 */
export function ensureRipgreprcRelease(
  targetPath: string = join(homedir(), '.ripgreprc'),
): boolean {
  if (!getManageRipgreprc()) return false
  if (process.env.RIPGREP_CONFIG_PATH) return false
  if (existsSync(targetPath)) return false
  try {
    writeFileSync(targetPath, RIPGREPRC_CONTENT, { mode: 0o644 })
    return true
  } catch {
    // A failed release (read-only HOME, dangling symlink) must never gate
    // startup — rg just keeps its built-in defaults.
    return false
  }
}
