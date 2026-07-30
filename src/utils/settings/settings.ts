import mergeWith from 'lodash-es/mergeWith.js'
import { dirname, join, resolve } from 'path'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getUseCoworkPlugins,
} from '../../bootstrap/state.js'
import { uniq } from '../array.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { isENOENT } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { patchJsoncFile, safeParseJSONC, SETTINGS_DEEP_KEYS } from '../json.js'
import { logError } from '../log.js'
import { clone, jsonStringify } from '../slowOperations.js'
import {
  getExistingOrPreferredProjectConfigPath,
  getPreferredProjectConfigPath,
  getPreferredProjectConfigRelativePath,
  getProjectConfigRelativePaths,
} from '../projectConfigPaths.js'
import { getModelSettingsFilePath } from './modelSettings.js'
import { MODEL_SETTINGS_KEYS } from './modelSettingsKeys.js'
import { profileCheckpoint } from '../startupProfiler.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from './constants.js'
import { markInternalWrite } from './internalWrites.js'
import {
  getCachedParsedFile,
  getCachedSettingsForSource,
  getPluginSettingsBase,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settingsCache.js'
import {
  type AutoModeRuleSections,
  type AutoModeSettings,
  type SettingsJson,
  SettingsSchema,
} from './types.js'
import {
  parseSettingsData,
  type SettingsWithErrors,
  type ValidationError,
} from './validation.js'

/**
 * Handles file system errors appropriately
 * @param error The error to handle
 * @param path The file path that caused the error
 */
function handleFileSystemError(error: unknown, path: string): void {
  if (
    typeof error === 'object' &&
    error &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    logForDebugging(
      `Broken symlink or missing file encountered for settings at path: ${path}`,
    )
  } else {
    logError(error)
  }
}

/**
 * Parses a settings file into a structured format
 * @param path The path to the permissions file
 * @param source The source of the settings (optional, for error reporting)
 * @returns Parsed settings data and validation errors
 */
export function parseSettingsFile(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const cached = getCachedParsedFile(path)
  if (cached) {
    // Clone so callers (e.g. mergeWith in getSettingsForSourceUncached,
    // updateSettingsForSource) can't mutate the cached entry.
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: cached.errors,
    }
  }
  const result = parseSettingsFileUncached(path)
  setCachedParsedFile(path, result)
  // Clone the first return too — the caller may mutate before
  // another caller reads the same cache entry.
  return {
    settings: result.settings ? clone(result.settings) : null,
    errors: result.errors,
  }
}

function parseSettingsFileUncached(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), path)
    const content = readFileSync(resolvedPath)

    if (content.trim() === '') {
      return { settings: {}, errors: [] }
    }

    const data = safeParseJSONC(content, false)

    // Project before validating: a general key in modelSettings.json must not
    // be able to fail validation and null out the whole file's model config.
    return parseSettingsData(projectIfModelSettings(data, path), path)
  } catch (error) {
    handleFileSystemError(error, path)
    return { settings: null, errors: [] }
  }
}

/**
 * modelSettings.json owns model/provider config; freecode.json owns everything
 * else. Writes are already routed by MODEL_SETTINGS_KEYS, so reads are filtered
 * to match — without this, a stray general key in modelSettings.json would
 * silently outrank freecode.json, since it merges second and the schema is
 * .passthrough().
 *
 * Applied to the raw JSON before schema validation, so an invalid general key
 * can't fail the whole file and take its model config down with it. Keys outside
 * MODEL_SETTINGS_KEYS are ignored, not migrated.
 */
function projectIfModelSettings(data: unknown, path: string): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  if (resolve(path) !== resolve(getModelSettingsFilePath())) return data

  const projected: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (MODEL_SETTINGS_KEYS.has(key)) {
      projected[key] = value
    }
  }
  return projected
}

/**
 * Get the absolute path to the associated file root for a given settings source
 * (e.g. for $PROJ_DIR/.freecode/freecode.json, returns $PROJ_DIR)
 * @param source The source of the settings
 * @returns The root path of the settings file
 */
export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return resolve(getClaudeConfigHomeDir())
    case 'projectSettings':
    case 'localSettings': {
      return resolve(getOriginalCwd())
    }
    case 'flagSettings': {
      const path = getFlagSettingsPath()
      return path ? dirname(resolve(path)) : resolve(getOriginalCwd())
    }
  }
}

/**
 * Get the user settings filename based on cowork mode.
 */
function getUserSettingsFilePath(): string {
  if (
    getUseCoworkPlugins() ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)
  ) {
    return 'cowork_settings.json'
  }
  return 'freecode.json'
}

export function getSettingsFilePathForSource(
  source: SettingSource,
): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(
        getSettingsRootPathForSource(source),
        getUserSettingsFilePath(),
      )
    case 'projectSettings':
    case 'localSettings': {
      return join(
        getSettingsRootPathForSource(source),
        getRelativeSettingsFilePathForSource(source),
      )
    }
    case 'flagSettings': {
      return getFlagSettingsPath()
    }
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  switch (source) {
    case 'projectSettings':
      return getPreferredProjectConfigRelativePath('freecode.json')
    case 'localSettings':
      return getPreferredProjectConfigRelativePath('freecode.local.json')
  }
}

/**
 * Returns all candidate file paths for a source, in precedence order (last wins).
 * For project settings, returns both .claude/ and .freecode/ paths.
 * For local settings, only .freecode/ is used.
 * For user settings, returns freecode.json and modelSettings.json.
 */
export function getSettingsFilePathsForSource(source: SettingSource): string[] {
  switch (source) {
    case 'userSettings': {
      const single = getSettingsFilePathForSource(source)
      const paths = single ? [single] : []
      paths.push(getModelSettingsFilePath())
      return paths
    }
    case 'projectSettings': {
      const root = getSettingsRootPathForSource(source)
      return getProjectConfigRelativePaths('freecode.json').map(rel =>
        join(root, rel),
      )
    }
    case 'localSettings': {
      const root = getSettingsRootPathForSource(source)
      return [
        join(
          root,
          getPreferredProjectConfigRelativePath('freecode.local.json'),
        ),
      ]
    }
    default: {
      const single = getSettingsFilePathForSource(source)
      return single ? [single] : []
    }
  }
}

/**
 * Returns the write path for a source. For project/local settings, uses the
 * existing .freecode/ path if present, else existing .claude/ path, else .freecode/.
 */
function getSettingsWritePathForSource(
  source: EditableSettingSource,
): string | undefined {
  switch (source) {
    case 'projectSettings':
      return getExistingOrPreferredProjectConfigPath(
        getOriginalCwd(),
        'freecode.json',
      )
    case 'localSettings':
      return getPreferredProjectConfigPath(
        getOriginalCwd(),
        'freecode.local.json',
      )
    default:
      return getSettingsFilePathForSource(source)
  }
}

export function getSettingsForSource(
  source: SettingSource,
): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) return cached
  const result = getSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, result)
  return result
}

function getSettingsForSourceUncached(
  source: SettingSource,
): SettingsJson | null {
  // Merge all candidate files for this source (handles .claude/ + .freecode/)
  const filePaths = getSettingsFilePathsForSource(source)
  let merged: SettingsJson | null = null
  for (const filePath of filePaths) {
    const { settings } = parseSettingsFile(filePath)
    if (settings) {
      merged = merged
        ? (mergeWith(merged, settings, settingsMergeCustomizer) as SettingsJson)
        : settings
    }
  }

  // For flagSettings, merge in any inline settings set via the SDK
  if (source === 'flagSettings') {
    const inlineSettings = getFlagSettingsInline()
    if (inlineSettings) {
      const parsed = SettingsSchema().safeParse(inlineSettings)
      if (parsed.success) {
        return mergeWith(
          merged || {},
          parsed.data,
          settingsMergeCustomizer,
        ) as SettingsJson
      }
    }
  }

  return merged
}

/**
 * Merges `settings` into the existing settings for `source` using lodash mergeWith.
 *
 * To delete a key from a record field (e.g. enabledPlugins, extraKnownMarketplaces),
 * set it to `undefined` — do NOT use `delete`. mergeWith only detects deletion when
 * the key is present with an explicit `undefined` value.
 */
export function updateSettingsForSource(
  source: EditableSettingSource,
  settings: SettingsJson,
): { error: Error | null } {
  if ((source as unknown) === 'flagSettings') {
    return { error: null }
  }

  // Create the folder if needed
  const filePath = getSettingsWritePathForSource(source)
  if (!filePath) {
    return { error: null }
  }

  try {
    getFsImplementation().mkdirSync(dirname(filePath))

    // Try to get existing settings with validation. Bypass the per-source
    // cache — mergeWith below mutates its target (including nested refs),
    // and mutating the cached object would leak unpersisted state if the
    // write fails before resetSettingsCache().
    let existingSettings = getSettingsForSourceUncached(source)

    // If validation failed, check if file exists with a JSON syntax error
    if (!existingSettings) {
      let content: string | null = null
      try {
        content = readFileSync(filePath)
      } catch (e) {
        if (!isENOENT(e)) {
          throw e
        }
        // File doesn't exist — fall through to merge with empty settings
      }
      if (content !== null) {
        const rawData = safeParseJSONC(content)
        if (rawData === null) {
          // JSONC syntax error - return validation error instead of overwriting
          // safeParseJSONC will already log the error, so we'll just return the error here
          return {
            error: new Error(
              `Invalid JSON syntax in settings file at ${filePath}`,
            ),
          }
        }
        if (rawData && typeof rawData === 'object') {
          existingSettings = rawData as SettingsJson
          logForDebugging(
            `Using raw settings from ${filePath} due to validation failure`,
          )
        }
      }
    }

    // Snapshot before mergeWith mutates `existingSettings` in place, so we
    // can diff old-vs-new and feed only the genuinely-changed keys to
    // patchJsoncFile (preserves JSONC comments on untouched keys).
    const beforeSnapshot = clone(existingSettings || {}) as Record<
      string,
      unknown
    >

    const updatedSettings = mergeWith(
      existingSettings || {},
      settings,
      (
        _objValue: unknown,
        srcValue: unknown,
        key: string | number | symbol,
        object: Record<string | number | symbol, unknown>,
      ) => {
        // Handle undefined as deletion
        if (srcValue === undefined && object && typeof key === 'string') {
          delete object[key]
          return undefined
        }
        // For arrays, always replace with the provided array
        // This puts the responsibility on the caller to compute the desired final state
        if (Array.isArray(srcValue)) {
          return srcValue
        }
        // For non-arrays, let lodash handle the default merge behavior
        return undefined
      },
    )

    // Build a shallow patch of the keys that actually changed. For keys in
    // SETTINGS_DEEP_KEYS, do a per-child diff so untouched sibling children
    // (e.g. providers.anthropic when only providers['claude-ai'] changed)
    // are NOT re-emitted — preserving inside-subtree comments on them.
    const afterObj = updatedSettings as Record<string, unknown>
    const isPlainObj = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
    const changed: Record<string, unknown> = {}
    const topKeys = new Set([
      ...Object.keys(beforeSnapshot),
      ...Object.keys(afterObj),
    ])
    for (const k of topKeys) {
      const a = beforeSnapshot[k]
      const b = afterObj[k]
      if (jsonStringify(a) === jsonStringify(b)) continue
      if (SETTINGS_DEEP_KEYS.has(k) && isPlainObj(a) && isPlainObj(b)) {
        const sub: Record<string, unknown> = {}
        const childKeys = new Set([...Object.keys(a), ...Object.keys(b)])
        for (const ck of childKeys) {
          if (jsonStringify(a[ck]) !== jsonStringify(b[ck])) {
            sub[ck] = b[ck]
          }
        }
        if (Object.keys(sub).length > 0) changed[k] = sub
      } else {
        // Scalar / array / missing-on-one-side: replace wholesale.
        // `b === undefined` (key deleted) → patchJsoncFile emits a delete edit.
        changed[k] = b
      }
    }

    // For userSettings, route model keys to modelSettings.json and the
    // rest to freecode.json. Other sources write everything to one file.
    if (source === 'userSettings' && Object.keys(changed).length > 0) {
      const modelChanged: Record<string, unknown> = {}
      const generalChanged: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(changed)) {
        if (MODEL_SETTINGS_KEYS.has(k)) {
          modelChanged[k] = v
        } else {
          generalChanged[k] = v
        }
      }

      if (Object.keys(modelChanged).length > 0) {
        const modelPath = getModelSettingsFilePath()
        let modelRaw: string | null = null
        try {
          modelRaw = readFileSync(modelPath)
        } catch (e) {
          if (!isENOENT(e)) throw e
        }
        markInternalWrite(modelPath)
        getFsImplementation().mkdirSync(dirname(modelPath))
        writeFileSyncAndFlush_DEPRECATED(
          modelPath,
          patchJsoncFile(modelRaw, modelChanged),
        )
      }

      if (Object.keys(generalChanged).length > 0) {
        let rawContent: string | null = null
        try {
          rawContent = readFileSync(filePath)
        } catch (e) {
          if (!isENOENT(e)) throw e
        }
        markInternalWrite(filePath)
        writeFileSyncAndFlush_DEPRECATED(
          filePath,
          patchJsoncFile(rawContent, generalChanged),
        )
      }
    } else {
      // Re-read raw file content (preserves comments) for the JSONC patch.
      let rawContent: string | null = null
      try {
        rawContent = readFileSync(filePath)
      } catch (e) {
        if (!isENOENT(e)) {
          throw e
        }
        // ENOENT: patchJsoncFile handles null content by serializing fresh.
      }

      // Mark this as an internal write before writing the file
      markInternalWrite(filePath)

      writeFileSyncAndFlush_DEPRECATED(
        filePath,
        patchJsoncFile(rawContent, changed),
      )
    }

    // Invalidate the session cache since settings have been updated
    resetSettingsCache()

    if (source === 'localSettings') {
      // Okay to add to gitignore async without awaiting
      void addFileGlobRuleToGitignore(
        getRelativeSettingsFilePathForSource('localSettings'),
        getOriginalCwd(),
      )
    }
  } catch (e) {
    const error = new Error(
      `Failed to read raw settings from ${filePath}: ${e}`,
    )
    logError(error)
    return { error }
  }

  return { error: null }
}

/**
 * Custom merge function for arrays - concatenate and deduplicate
 */
function mergeArrays<T>(targetArray: T[], sourceArray: T[]): T[] {
  return uniq([...targetArray, ...sourceArray])
}

/**
 * Custom merge function for lodash mergeWith when merging settings.
 * Arrays are concatenated and deduplicated; other values use default lodash merge behavior.
 * Exported for testing.
 */
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)
  }
  // Return undefined to let lodash handle default merge behavior
  return undefined
}

// Flag to prevent infinite recursion when loading settings
let isLoadingSettings = false

/**
 * Load settings from disk without using cache
 * This is the original implementation that actually reads from files
 */
function loadSettingsFromDisk(): SettingsWithErrors {
  // Prevent recursive calls to loadSettingsFromDisk
  if (isLoadingSettings) {
    return { settings: {}, errors: [] }
  }

  const startTime = Date.now()
  profileCheckpoint('loadSettingsFromDisk_start')
  logForDiagnosticsNoPII('info', 'settings_load_started')

  isLoadingSettings = true
  try {
    // Start with plugin settings as the lowest priority base.
    // All file-based sources (user, project, local, flag, policy) override these.
    // Plugin settings only contain allowlisted keys (e.g., agent) that are valid SettingsJson fields.
    const pluginSettings = getPluginSettingsBase()
    let mergedSettings: SettingsJson = {}
    if (pluginSettings) {
      mergedSettings = mergeWith(
        mergedSettings,
        pluginSettings,
        settingsMergeCustomizer,
      )
    }
    const allErrors: ValidationError[] = []
    const seenErrors = new Set<string>()
    const seenFiles = new Set<string>()

    // Merge settings from each source in priority order with deep merging
    const enabledSrc = getEnabledSettingSources()
    for (const source of enabledSrc) {
      const filePaths = getSettingsFilePathsForSource(source)
      for (const filePath of filePaths) {
        const resolvedPath = resolve(filePath)

        // Skip if we've already loaded this file from another source
        if (seenFiles.has(resolvedPath)) continue
        seenFiles.add(resolvedPath)

        const { settings, errors } = parseSettingsFile(filePath)

        for (const error of errors) {
          const errorKey = `${error.file}:${error.path}:${error.message}`
          if (!seenErrors.has(errorKey)) {
            seenErrors.add(errorKey)
            allErrors.push(error)
          }
        }

        if (settings) {
          mergedSettings = mergeWith(
            mergedSettings,
            settings,
            settingsMergeCustomizer,
          )
        }
      }

      // For flagSettings, also merge any inline settings set via the SDK
      if (source === 'flagSettings') {
        const inlineSettings = getFlagSettingsInline()
        if (inlineSettings) {
          const parsed = SettingsSchema().safeParse(inlineSettings)
          if (parsed.success) {
            mergedSettings = mergeWith(
              mergedSettings,
              parsed.data,
              settingsMergeCustomizer,
            )
          }
        }
      }
    }

    logForDiagnosticsNoPII('info', 'settings_load_completed', {
      duration_ms: Date.now() - startTime,
      source_count: seenFiles.size,
      error_count: allErrors.length,
    })

    return { settings: mergedSettings, errors: allErrors }
  } finally {
    isLoadingSettings = false
  }
}

/**
 * Get merged settings from all sources in priority order
 * Settings are merged from lowest to highest priority:
 * userSettings -> projectSettings -> localSettings -> flagSettings
 *
 * This function returns a snapshot of settings at the time of call.
 * For React components, prefer using useSettings() hook for reactive updates
 * when settings change on disk.
 *
 * Uses session-level caching to avoid repeated file I/O.
 * Cache is invalidated when settings files change via resetSettingsCache().
 *
 * @returns Merged settings from all available sources (always returns at least empty object)
 */
export function getInitialSettings(): SettingsJson {
  const { settings } = getSettingsWithErrors()
  return settings || {}
}

/**
 * @deprecated Use getInitialSettings() instead. This alias exists for backwards compatibility.
 */
export const getSettings_DEPRECATED = getInitialSettings

export type SettingsWithSources = {
  effective: SettingsJson
  /** Ordered low-to-high priority — later entries override earlier ones. */
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

/**
 * Get the effective merged settings alongside the raw per-source settings,
 * in merge-priority order. Only includes sources that are enabled and have
 * non-empty content.
 *
 * Always reads fresh from disk — resets the session cache so that `effective`
 * and `sources` are consistent even if the change detector hasn't fired yet.
 */
export function getSettingsWithSources(): SettingsWithSources {
  // Reset both caches so getSettingsForSource (per-source cache) and
  // getInitialSettings (session cache) agree on the current disk state.
  resetSettingsCache()
  const sources: SettingsWithSources['sources'] = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings && Object.keys(settings).length > 0) {
      sources.push({ source, settings })
    }
  }
  return { effective: getInitialSettings(), sources }
}

/**
 * Get merged settings and validation errors from all sources
 * This function now uses session-level caching to avoid repeated file I/O.
 * Settings changes require Claude Code restart, so cache is valid for entire session.
 * @returns Merged settings and all validation errors encountered
 */
export function getSettingsWithErrors(): SettingsWithErrors {
  const cached = getSessionSettingsCache()
  if (cached !== null) {
    return cached
  }

  const result = loadSettingsFromDisk()
  profileCheckpoint('loadSettingsFromDisk_end')
  setSessionSettingsCache(result)
  return result
}

/**
 * Check if any raw settings file contains a specific key, regardless of validation.
 * This is useful for detecting user intent even when settings validation fails.
 * For example, if a user set cleanupPeriodDays but has validation errors elsewhere,
 * we can detect they explicitly configured cleanup and skip cleanup rather than
 * falling back to defaults.
 */
/**
 * Returns true if any trusted settings source has accepted the bypass
 * permissions mode dialog. projectSettings is intentionally excluded —
 * a malicious project could otherwise auto-bypass the dialog (RCE risk).
 */
export function hasSkipDangerousModePermissionPrompt(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('localSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('flagSettings')?.skipDangerousModePermissionPrompt
  )
}

/**
 * Returns whether plan mode should use auto mode semantics. Default true
 * (opt-out). Returns false if any trusted source explicitly sets false.
 * projectSettings is excluded so a malicious project can't control this.
 */
export function getUseAutoModeDuringPlan(): boolean {
  return (
    getSettingsForSource('flagSettings')?.useAutoModeDuringPlan !== false &&
    getSettingsForSource('userSettings')?.useAutoModeDuringPlan !== false &&
    getSettingsForSource('localSettings')?.useAutoModeDuringPlan !== false
  )
}

function getAutoModeSettingsObject(
  settings: SettingsJson | null | undefined,
): AutoModeSettings | undefined {
  const autoMode = settings?.autoMode
  return autoMode && typeof autoMode === 'object' && !Array.isArray(autoMode)
    ? autoMode
    : undefined
}

/**
 * Returns trusted autoMode section replacements, excluding project settings.
 * projectSettings is intentionally excluded — a malicious project could
 * otherwise inject classifier allow/deny rules (RCE risk).
 */
export function getTrustedAutoModeRuleSections():
  | AutoModeRuleSections
  | undefined {
  let sections: AutoModeRuleSections | undefined
  for (const source of [
    'userSettings',
    'localSettings',
    'flagSettings',
  ] as const) {
    const autoMode = getAutoModeSettingsObject(getSettingsForSource(source))
    if (!autoMode) continue

    for (const key of ['environment', 'deny', 'allow'] as const) {
      const value = autoMode[key]
      if (Array.isArray(value)) {
        sections = { ...sections, [key]: value }
      }
    }
  }
  return sections
}

export function getAutoModeClassifierModelFromSettings(
  settings: SettingsJson,
): string | undefined {
  return getAutoModeSettingsObject(settings)?.classifierModel
}

export function getAutoModeClassifierModelSetting(): string | undefined {
  const { settings } = getSettingsWithErrors()
  return getAutoModeClassifierModelFromSettings(settings)
}

export function rawSettingsContainsKey(key: string): boolean {
  for (const source of getEnabledSettingSources()) {
    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) {
      continue
    }

    try {
      const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
      const content = readFileSync(resolvedPath)
      if (!content.trim()) {
        continue
      }

      const rawData = safeParseJSONC(content, false)
      if (rawData && typeof rawData === 'object' && key in rawData) {
        return true
      }
    } catch (error) {
      // File not found is expected - not all settings files exist
      // Other errors (permissions, I/O) should be tracked
      handleFileSystemError(error, filePath)
    }
  }

  return false
}
