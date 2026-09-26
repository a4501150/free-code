/**
 * Utilities for managing shell configuration files (like .bashrc, .zshrc)
 * Used for managing claude aliases and PATH entries
 */

import { readFile, stat } from 'fs/promises'
import { homedir as osHomedir } from 'os'
import { join } from 'path'
import { isFsInaccessible } from './errors.js'

export const CLAUDE_ALIAS_REGEX = /^\s*alias\s+claude\s*=/

type EnvLike = Record<string, string | undefined>

type ShellConfigOptions = {
  env?: EnvLike
  homedir?: string
}

/**
 * Get the paths to shell configuration files
 * Respects ZDOTDIR for zsh users
 * @param options Optional overrides for testing (env, homedir)
 */
export function getShellConfigPaths(
  options?: ShellConfigOptions,
): Record<string, string> {
  const home = options?.homedir ?? osHomedir()
  const env = options?.env ?? process.env
  const zshConfigDir = env.ZDOTDIR || home
  return {
    zsh: join(zshConfigDir, '.zshrc'),
    bash: join(home, '.bashrc'),
    fish: join(home, '.config/fish/config.fish'),
  }
}

/**
 * Read a file and split it into lines
 * Returns null if file doesn't exist or can't be read
 */
export async function readFileLines(
  filePath: string,
): Promise<string[] | null> {
  try {
    const content = await readFile(filePath, { encoding: 'utf8' })
    return content.split('\n')
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * Check if a claude alias exists in any shell config file
 * Returns the alias target if found, null otherwise
 * @param options Optional overrides for testing (env, homedir)
 */
export async function findClaudeAlias(
  options?: ShellConfigOptions,
): Promise<string | null> {
  const configs = getShellConfigPaths(options)

  for (const configPath of Object.values(configs)) {
    const lines = await readFileLines(configPath)
    if (!lines) continue

    for (const line of lines) {
      if (CLAUDE_ALIAS_REGEX.test(line)) {
        // Extract the alias target
        const match = line.match(/alias\s+claude=["']?([^"'\s]+)/)
        if (match && match[1]) {
          return match[1]
        }
      }
    }
  }

  return null
}

/**
 * Check if a claude alias exists and points to a valid executable
 * Returns the alias target if valid, null otherwise
 * @param options Optional overrides for testing (env, homedir)
 */
export async function findValidClaudeAlias(
  options?: ShellConfigOptions,
): Promise<string | null> {
  const aliasTarget = await findClaudeAlias(options)
  if (!aliasTarget) return null

  const home = options?.homedir ?? osHomedir()

  // Expand ~ to home directory
  const expandedPath = aliasTarget.startsWith('~')
    ? aliasTarget.replace('~', home)
    : aliasTarget

  // Check if the target exists and is executable
  try {
    const stats = await stat(expandedPath)
    // Check if it's a file (could be executable or symlink)
    if (stats.isFile() || stats.isSymbolicLink()) {
      return aliasTarget
    }
  } catch {
    // Target doesn't exist or can't be accessed
  }

  return null
}
