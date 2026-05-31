import { existsSync } from 'fs'
import { join } from 'path'

export const LEGACY_PROJECT_CONFIG_DIR = '.claude'
export const PREFERRED_PROJECT_CONFIG_DIR = '.freecode'

// In precedence order: last wins
export const PROJECT_CONFIG_DIRS = [
  LEGACY_PROJECT_CONFIG_DIR,
  PREFERRED_PROJECT_CONFIG_DIR,
] as const

/**
 * Returns all candidate paths in precedence order (last wins).
 * e.g. getProjectConfigPaths('/proj', 'agents') =>
 *   ['/proj/.claude/agents', '/proj/.freecode/agents']
 */
export function getProjectConfigPaths(
  projectRoot: string,
  ...segments: string[]
): string[] {
  return PROJECT_CONFIG_DIRS.map(dir => join(projectRoot, dir, ...segments))
}

/**
 * Returns relative paths in precedence order (last wins).
 * e.g. getProjectConfigRelativePaths('freecode.json') =>
 *   ['.claude/freecode.json', '.freecode/freecode.json']
 */
export function getProjectConfigRelativePaths(
  ...segments: string[]
): string[] {
  return PROJECT_CONFIG_DIRS.map(dir => join(dir, ...segments))
}

/**
 * Returns the preferred path for new file creation.
 * Always uses .freecode/.
 */
export function getPreferredProjectConfigPath(
  projectRoot: string,
  ...segments: string[]
): string {
  return join(projectRoot, PREFERRED_PROJECT_CONFIG_DIR, ...segments)
}

/**
 * Returns the preferred relative path for new file creation.
 */
export function getPreferredProjectConfigRelativePath(
  ...segments: string[]
): string {
  return join(PREFERRED_PROJECT_CONFIG_DIR, ...segments)
}

/**
 * Returns the path for writes: existing .freecode/ path if it exists,
 * else existing .claude/ path, else .freecode/ (default for new files).
 */
export function getExistingOrPreferredProjectConfigPath(
  projectRoot: string,
  ...segments: string[]
): string {
  const preferred = join(
    projectRoot,
    PREFERRED_PROJECT_CONFIG_DIR,
    ...segments,
  )
  if (existsSync(preferred)) return preferred

  const legacy = join(projectRoot, LEGACY_PROJECT_CONFIG_DIR, ...segments)
  if (existsSync(legacy)) return legacy

  return preferred
}
