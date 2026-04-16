/**
 * Freecode Settings — ~/.claude/freecode.json
 *
 * Single unified config file for freecode. Combines what was previously
 * split between settings.json and providers.json (both now legacy).
 *
 * Schema: same as SettingsSchema with providers, defaultModel,
 * defaultSubagentModel as native fields.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'

// Keys that should appear last in freecode.json, in order.
// All other keys appear before these in their natural insertion order.
const BOTTOM_KEYS = [
  'defaultModel',
  'defaultSubagentModel',
  'defaultSmallFastModel',
  'autoModeClassifierModel',
  'mcpServers',
  'providers',
]

/**
 * Reorder keys for readability: large/structural blocks (mcpServers, providers)
 * go to the bottom, model defaults are grouped together above them.
 */
export function orderFreecodeKeys(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const bottomSet = new Set(BOTTOM_KEYS)

  // First: all keys not in the bottom set, in original order
  for (const key of Object.keys(obj)) {
    if (!bottomSet.has(key)) {
      result[key] = obj[key]
    }
  }

  // Then: bottom keys in defined order (skip missing)
  for (const key of BOTTOM_KEYS) {
    if (key in obj && obj[key] !== undefined) {
      result[key] = obj[key]
    }
  }

  return result
}

export function getFreecodeSettingsFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'freecode.json')
}

/**
 * Check if freecode.json exists.
 */
export function freecodeSettingsFileExists(): boolean {
  return existsSync(getFreecodeSettingsFilePath())
}

/**
 * Read freecode.json. Returns null if file doesn't exist or is invalid.
 */
export function readFreecodeSettingsFile(): Record<string, unknown> | null {
  let content: string
  try {
    content = readFileSync(getFreecodeSettingsFilePath(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    logError(e)
    return null
  }

  const parsed = safeParseJSON(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/**
 * Write to freecode.json (read-merge-write).
 * Preserves existing keys not in the partial update.
 */
export function writeFreecodeSettingsFile(
  partial: Record<string, unknown>,
): void {
  try {
    const filePath = getFreecodeSettingsFilePath()
    const existing = readFreecodeSettingsFile() ?? {}

    // Deep merge for providers: incoming providers overwrite by name
    let mergedProviders = existing.providers
    if (partial.providers && typeof partial.providers === 'object') {
      mergedProviders = {
        ...(typeof existing.providers === 'object' && existing.providers !== null
          ? existing.providers
          : {}),
        ...(partial.providers as Record<string, unknown>),
      }
    }

    const merged: Record<string, unknown> = {
      ...existing,
      ...partial,
    }
    if (mergedProviders !== undefined) {
      merged.providers = mergedProviders
    }

    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      jsonStringify(merged, null, 2) + '\n',
    )
  } catch (e) {
    logError(e)
  }
}

/**
 * Update a specific model entry within a provider's models array in freecode.json.
 * Does in-place mutation of the parsed object to preserve key ordering.
 * Keys set to undefined in `updates` are deleted from the model entry.
 */
export function updateProviderModelConfig(
  providerName: string,
  modelId: string,
  updates: Record<string, unknown>,
): void {
  try {
    const settings = readFreecodeSettingsFile()
    if (!settings) return

    const providers = settings.providers as Record<string, { models?: Array<Record<string, unknown>> }> | undefined
    if (!providers) return

    const provider = providers[providerName]
    if (!provider?.models) return

    const modelEntry = provider.models.find(
      (m) => m.id === modelId,
    )
    if (!modelEntry) return

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete modelEntry[key]
      } else {
        modelEntry[key] = value
      }
    }

    const filePath = getFreecodeSettingsFilePath()
    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      jsonStringify(settings, null, 2) + '\n',
    )
  } catch (e) {
    logError(e)
  }
}

/**
 * Reorder freecode.json keys in place for readability.
 * Direct read-reorder-write (not merge) so key order is fully replaced.
 */
export function reorderFreecodeSettingsFile(): void {
  try {
    const filePath = getFreecodeSettingsFilePath()
    const settings = readFreecodeSettingsFile()
    if (!settings) return
    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      jsonStringify(orderFreecodeKeys(settings), null, 2) + '\n',
    )
  } catch (e) {
    logError(e)
  }
}
