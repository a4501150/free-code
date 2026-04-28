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
import { patchJsoncFile, safeParseJSONC } from '../json.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'

// Keys that should appear last in freecode.json, in order.
// All other keys appear before these in their natural insertion order.
const BOTTOM_KEYS = [
  'defaultModel',
  'defaultSubagentModel',
  'defaultSmallFastModel',
  'defaultBalancedModel',
  'defaultMostPowerfulModel',
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

  const parsed = safeParseJSONC(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  return parsed as Record<string, unknown>
}

/**
 * Write to freecode.json, preserving JSONC comments outside the changed scope.
 *
 * Merge contract:
 *   - Top-level keys overwrite shallowly. Omit a key to leave the existing
 *     value unchanged; pass `undefined` to delete it.
 *   - Keys in `SETTINGS_DEEP_KEYS` (e.g. `providers`, `mcpServers`, `permissions`)
 *     merge one level deeper by child name: each child supplied in the partial
 *     is re-emitted; children not listed are left untouched. Callers MUST
 *     supply a complete value per child slot they touch — partial updates to
 *     inner fields of a child (e.g. changing only `baseUrl` of an existing
 *     provider) are NOT supported and will drop every other field of that
 *     child. For model-level edits, use `updateProviderModelConfig`.
 *   - Load-bearing for `/login`: OAuth completion writes
 *     `{ providers: { 'claude-ai': {...full config} } }` and sibling providers
 *     like `anthropic` are preserved (including any comments attached to them).
 *
 * Comment preservation:
 *   - Comments outside a replaced node survive.
 *   - Comments INSIDE a replaced child subtree are lost (the subtree is
 *     replaced wholesale with the new serialized value).
 */
export function writeFreecodeSettingsFile(
  partial: Record<string, unknown>,
): void {
  try {
    const filePath = getFreecodeSettingsFilePath()

    let rawContent: string | null = null
    try {
      rawContent = readFileSync(filePath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logError(e)
        return
      }
      // ENOENT: patchJsoncFile handles null content by serializing fresh.
    }

    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      patchJsoncFile(rawContent, partial),
    )
  } catch (e) {
    logError(e)
  }
}

/**
 * Update a specific model entry within a provider's models array in freecode.json.
 * Does in-place mutation of the parsed object to preserve model key ordering,
 * then re-emits just the touched provider slot via `writeFreecodeSettingsFile`
 * so sibling providers (and any comments attached to them) are left untouched.
 *
 * Keys set to undefined in `updates` are deleted from the model entry.
 *
 * Note: inside-subtree comments on the touched provider (including the
 * models array) are lost, consistent with the merge contract documented on
 * `writeFreecodeSettingsFile`.
 */
export function updateProviderModelConfig(
  providerName: string,
  modelId: string,
  updates: Record<string, unknown>,
): void {
  try {
    const settings = readFreecodeSettingsFile()
    if (!settings) return

    const providers = settings.providers as
      | Record<string, { models?: Array<Record<string, unknown>> }>
      | undefined
    if (!providers) return

    const provider = providers[providerName]
    if (!provider?.models) return

    const modelEntry = provider.models.find(m => m.id === modelId)
    if (!modelEntry) return

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete modelEntry[key]
      } else {
        modelEntry[key] = value
      }
    }

    writeFreecodeSettingsFile({ providers: { [providerName]: provider } })
  } catch (e) {
    logError(e)
  }
}

/**
 * Reorder freecode.json keys in place for readability.
 *
 * Destroys comments by design — jsonc-parser cannot move comment tokens
 * across key boundaries, so achieving canonical key order requires a full
 * plain-JSON re-emit. Call only from one-shot migration paths (where the
 * file has no user-authored comments yet), never from user-facing writes.
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
