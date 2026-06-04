/**
 * Model Settings — ~/.freecode/modelSettings.json
 *
 * Provider and model routing configuration, separated from the general
 * freecode.json settings file. Contains provider definitions (type, auth,
 * models, capabilities), default model selections, and model overrides.
 *
 * Schema: same SettingsSchema — only the model-related keys are expected
 * here, but .passthrough() allows any key to survive a read/write round-trip.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { patchJsoncFile, safeParseJSONC } from '../json.js'
import { logError } from '../log.js'
import { markInternalWrite } from './internalWrites.js'
import { resetSettingsCache } from './settingsCache.js'

export function getModelSettingsFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'modelSettings.json')
}

export function modelSettingsFileExists(): boolean {
  return existsSync(getModelSettingsFilePath())
}

export function readModelSettingsFile(): Record<string, unknown> | null {
  let content: string
  try {
    content = readFileSync(getModelSettingsFilePath(), 'utf8')
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
 * Write to modelSettings.json, preserving JSONC comments outside the changed scope.
 *
 * Merge contract is identical to writeFreecodeSettingsFile:
 *   - Top-level keys overwrite shallowly. Omit a key to leave unchanged;
 *     pass `undefined` to delete.
 *   - Keys in SETTINGS_DEEP_KEYS (e.g. `providers`) merge one level deeper.
 */
export function writeModelSettingsFile(partial: Record<string, unknown>): void {
  try {
    const filePath = getModelSettingsFilePath()

    let rawContent: string | null = null
    try {
      rawContent = readFileSync(filePath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logError(e)
        return
      }
    }

    markInternalWrite(filePath)
    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      patchJsoncFile(rawContent, partial),
    )
    resetSettingsCache()
  } catch (e) {
    logError(e)
  }
}

/**
 * Update a specific model entry within a provider's models array in modelSettings.json.
 *
 * Keys set to undefined in `updates` are deleted from the model entry.
 */
export function updateProviderModelConfig(
  providerName: string,
  modelId: string,
  updates: Record<string, unknown>,
): void {
  try {
    const settings = readModelSettingsFile()
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

    writeModelSettingsFile({ providers: { [providerName]: provider } })
  } catch (e) {
    logError(e)
  }
}
