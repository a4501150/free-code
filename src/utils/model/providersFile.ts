/**
 * Providers File — ~/.claude/providers.json
 *
 * Single source of truth for provider configuration.
 * Written by: env var migration (startup), OAuth login, token refresh.
 * Read by: ProviderRegistry at init time.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { ProviderConfig } from '../settings/types.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { safeParseJSON } from '../json.js'
import { jsonStringify } from '../slowOperations.js'
import { logError } from '../log.js'

export function getProvidersFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'providers.json')
}

/**
 * Read providers from ~/.claude/providers.json.
 * Returns null if file doesn't exist or is invalid.
 * Silently returns null on ENOENT (expected on first run).
 */
export function readProvidersFile(): Record<string, ProviderConfig> | null {
  let content: string
  try {
    content = readFileSync(getProvidersFilePath(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    logError(e)
    return null
  }

  const parsed = safeParseJSON(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  return parsed as Record<string, ProviderConfig>
}

/**
 * Write providers to ~/.claude/providers.json.
 * Does per-key overwrite: existing providers not in the incoming set are preserved.
 * Providers in the incoming set replace the existing entry entirely.
 * Non-fatal on errors.
 */
export function writeProvidersFile(
  providers: Record<string, ProviderConfig>,
): void {
  try {
    const filePath = getProvidersFilePath()
    const existing = readProvidersFile() ?? {}

    // Per-key overwrite: incoming providers replace existing by name
    const merged = { ...existing, ...providers }

    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      jsonStringify(merged, null, 2) + '\n',
    )
  } catch (e) {
    logError(e)
  }
}
