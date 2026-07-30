import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { findCanonicalGitRoot } from './git.js'
import { safeParseJSON } from './json.js'
import { stripBOM } from './jsonRead.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'

import * as teamMemPathsNs from '../memdir/teamMemPaths.js'

const teamMemPaths = feature('TEAMMEM') ? teamMemPathsNs : null
import type { ImageDimensions } from './imageResizer.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// Re-entrancy guard: prevents getConfig → logEvent → getGlobalConfig → getConfig
// infinite recursion when the config file is corrupted. logEvent's sampling check
// reads features from the global config, which calls getConfig again.
let insideGetConfig = false

// Image dimension info for coordinate mapping (only set when image was resized)
export type PastedContent = {
  id: number // Sequential numeric ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // e.g., 'image/png', 'image/jpeg'
  filename?: string // Display name for images in attachment slot
  dimensions?: ImageDimensions
  sourcePath?: string // Original file path for images dragged onto the terminal
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // Trust dialog settings
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP server approval fields - migrated to settings but kept for backward compatibility
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // List of disabled MCP servers (all scopes) - used for enable/disable toggle
  disabledMcpServers?: string[]
  // Opt-in list for built-in MCP servers that default to disabled
  enabledMcpServers?: string[]
  // Worktree session management
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type GlobalConfig = {
  projects?: Record<string, ProjectConfig>
  userID?: string
  firstStartTime?: string
  mcpServers?: Record<string, McpServerConfig>
  oauthAccount?: { accountUuid?: string }
  companion?: { name: string; personality: string; hatchedAt: number }
  companionMuted?: boolean
  hasUserClaudeMdMigrationPromptShown?: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
}

/**
 * Factory for a fresh default GlobalConfig. Used instead of deep-cloning a
 * shared constant — the nested containers (arrays, records) are all empty, so
 * a factory gives fresh refs at zero clone cost.
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {}
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * Check if the user has already accepted the trust dialog for the cwd.
 *
 * This function traverses parent directories to check if a parent directory
 * had approval. Accepting trust for a directory implies trust for child
 * directories.
 *
 * @returns Whether the trust dialog has been accepted (i.e. "should not be shown")
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // Trust only transitions false→true during a session (never the reverse),
  // so once true we can latch it. false is not cached — it gets re-checked
  // on every call so that trust dialog acceptance is picked up mid-session.
  // (lodash memoize doesn't fit here because it would also cache false.)
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // Check session-level trust (for home directory case where trust is not persisted)
  // When running from home dir, trust dialog is shown but acceptance is stored
  // in memory only. This allows hooks and other features to work during the session.
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // Always check where trust would be saved (git root or original cwd)
  // This is the primary location where trust is persisted by saveCurrentProjectConfig
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // Now check from current working directory and its parents
  // Normalize paths for consistent JSON key lookup
  let currentPath = normalizePathForConfigKey(getCwd())

  // Traverse all parent directories
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // Stop if we've reached the root (when parent is same as current)
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * Check trust for an arbitrary directory (not the session cwd).
 * Walks up from `dir`, returning true if any ancestor has trust persisted.
 * Unlike checkHasTrustDialogAccepted, this does NOT consult session trust or
 * the memoized project path — use when the target dir differs from cwd (e.g.
 * /assistant installing into a user-typed path).
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

// We have to put this test code here because Jest doesn't support mocking ES modules :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * Legacy auth-state-loss guard retained as a no-op. Auth and onboarding state
 * no longer live in GlobalConfig, so there is nothing left here to protect.
 */
function wouldLoseAuthState(_fresh: GlobalConfig): boolean {
  return false
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // Skip if no changes (same reference returned)
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  const file = getStateFilePath()
  let release: (() => void) | undefined

  try {
    try {
      release = lockfile.lockSync(file, {
        lockfilePath: `${file}.lock`,
        onCompromised: err => {
          logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
        },
      })
    } catch (lockErr) {
      logForDebugging(`Failed to acquire config lock: ${lockErr}`, {
        level: 'error',
      })
    }

    const currentConfig = readStateFromDisk()
    const config = updater(currentConfig)
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: currentConfig.projects,
    }

    createConfigBackup(file)
    writeStateToDisk(written)
    writeThroughGlobalConfigCache(written)
  } catch (error) {
    logForDebugging(`Failed to save global config: ${error}`, {
      level: 'error',
    })
    // Fallback: try without lock
    try {
      const currentConfig = readStateFromDisk()
      const config = updater(currentConfig)
      if (config === currentConfig) return
      written = { ...config, projects: currentConfig.projects }
      writeStateToDisk(written)
      writeThroughGlobalConfigCache(written)
    } catch {
      // Give up
    }
  } finally {
    release?.()
  }
}

function getStateFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'state.json')
}

/**
 * Read state from ~/.freecode/state.json.
 */
function readStateFromDisk(): GlobalConfig {
  const fs = getFsImplementation()
  const file = getStateFilePath()
  try {
    const content = fs.readFileSync(file, { encoding: 'utf-8' })
    const parsed = safeParseJSON(stripBOM(content))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createDefaultGlobalConfig()
    }
    return {
      ...createDefaultGlobalConfig(),
      ...(parsed as Partial<GlobalConfig>),
    }
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return createDefaultGlobalConfig()
    }
    throw error
  }
}

/**
 * Write the GlobalConfig to ~/.freecode/state.json.
 */
function writeStateToDisk(config: GlobalConfig): void {
  const defaultConfig = createDefaultGlobalConfig()
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !==
      jsonStringify(defaultConfig[key as keyof GlobalConfig]),
  )
  const file = getStateFilePath()
  const fs = getFsImplementation()
  try {
    fs.mkdirSync(dirname(file))
  } catch (e) {
    if (getErrnoCode(e) !== 'EEXIST') throw e
  }
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2) + '\n',
  )
  globalConfigWriteCount++
}

// Cache for global config
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// Tracking for config file operations (telemetry)
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
// Session-total count of actual disk writes to state.json.
// Exposed for dev diagnostics so anomalous write rates surface in the UI.
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  configCacheHits = 0
  configCacheMisses = 0
}

// Register cleanup to report cache stats at session end
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

// fs.watchFile poll interval for detecting writes from other instances (ms)
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile polls stat on the libuv threadpool and only calls us when mtime
// changed — a stalled stat never blocks the main thread.
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getStateFilePath()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: {
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            },
            mtime: curr.mtimeMs,
          }
          lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// Write-through: what we just wrote IS the new config. cache.mtime overshoots
// the file's real mtime (Date.now() is recorded after the write) so the
// freshness watcher skips re-reading our own write on its next tick.
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // Fast path: pure memory read. After startup, this always hits — our own
  // writes go write-through and other instances' writes are picked up by the
  // background freshness watcher (never blocks this path).
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // Slow path: startup load. Reads state.json.
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getStateFilePath())
    } catch {
      // File doesn't exist
    }
    const config = readStateFromDisk()
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats
      ? { mtime: stats.mtimeMs, size: stats.size }
      : null
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    return createDefaultGlobalConfig()
  }
}

export function getCustomApiKeyStatus(
  _truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  return 'approved'
}

// Flag to track if config reading is allowed
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // Ensure this is idempotent
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // Any reads to configuration before this flag is set show an console warning
  // to prevent us from adding config reading during module initialization
  configReadingAllowed = true
  readStateFromDisk()

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * Returns the directory where config backup files are stored.
 * Uses ~/.freecode/backups/ to keep the home directory clean.
 */
function getConfigBackupDir(): string {
  return join(getClaudeConfigHomeDir(), 'backups')
}

function createConfigBackup(file: string): void {
  const fs = getFsImplementation()
  try {
    const fileBase = basename(file)
    const backupDir = getConfigBackupDir()

    try {
      fs.mkdirSync(backupDir)
    } catch (mkdirErr) {
      if (getErrnoCode(mkdirErr) !== 'EEXIST') throw mkdirErr
    }

    const MIN_BACKUP_INTERVAL_MS = 60_000
    const existingBackups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()
      .reverse()

    const mostRecentBackup = existingBackups[0]
    const mostRecentTimestamp = mostRecentBackup
      ? Number(mostRecentBackup.split('.backup.').pop())
      : 0
    const shouldCreateBackup =
      Number.isNaN(mostRecentTimestamp) ||
      Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

    if (shouldCreateBackup) {
      const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
      fs.copyFileSync(file, backupPath)
    }

    const MAX_BACKUPS = 5
    const backupsForCleanup = shouldCreateBackup
      ? fs
          .readdirStringSync(backupDir)
          .filter(f => f.startsWith(`${fileBase}.backup.`))
          .sort()
          .reverse()
      : existingBackups

    for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
      try {
        fs.unlinkSync(join(backupDir, oldBackup))
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (e) {
    if (getErrnoCode(e) !== 'ENOENT') {
      logForDebugging(`Failed to backup config: ${e}`, { level: 'error' })
    }
  }
}

/**
 * Find the most recent backup file for a given config file.
 * Checks ~/.freecode/backups/ first, then falls back to the legacy location
 * (next to the config file) for backwards compatibility.
 * Returns the full path to the most recent backup, or null if none exist.
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // Check the new backup directory first
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // Timestamps sort lexicographically
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // Backup dir doesn't exist yet
  }

  // Fall back to legacy location (next to the config file)
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // Timestamps sort lexicographically
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // Check for legacy backup file (no timestamp)
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // Legacy backup doesn't exist
    }
  } catch {
    // Ignore errors reading directory
  }

  return null
}

function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // Log a warning if config is accessed before it's allowed
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // Throw a ConfigParseError with the file path and default config
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // Handle file not found - check for backup and return default
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nClaude configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // Re-throw ConfigParseError if throwOnInvalid is true
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // Log config parse errors so users know what happened
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      // Guard: logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // causes infinite recursion when the config file is corrupted, because
      // the sampling check reads a feature from global config.
      // Only log analytics on the outermost call.
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // Log the error for monitoring
          logError(error)

          // Log analytics event for config corruption
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // No backup
          }
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nClaude configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      // Try to backup the corrupted config file (only if not already backed up)
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // Ensure backup directory exists
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // Check if current corrupted content matches any existing backup
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // Ignore read errors on backups
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
          // Ignore backup errors
        }
      }

      // Notify user about corrupted config and available backup
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// Memoized function to get the project path for config lookup
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // Normalize for consistent JSON keys (forward slashes on all platforms)
    // This ensures paths like C:\Users\... and C:/Users/... map to the same key
    return normalizePathForConfigKey(gitRoot)
  }

  // Not in a git repo
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // Not sure how this became a string
  // TODO: Fix upstream
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // Skip if no changes (same reference returned)
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()
  const file = getStateFilePath()
  let release: (() => void) | undefined

  try {
    try {
      release = lockfile.lockSync(file, {
        lockfilePath: `${file}.lock`,
        onCompromised: err => {
          logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
        },
      })
    } catch (lockErr) {
      logForDebugging(`Failed to acquire config lock: ${lockErr}`, {
        level: 'error',
      })
    }

    const current = readStateFromDisk()
    const currentProjectConfig =
      current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    if (newProjectConfig === currentProjectConfig) return

    const written: GlobalConfig = {
      ...current,
      projects: {
        ...current.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    createConfigBackup(file)
    writeStateToDisk(written)
    writeThroughGlobalConfigCache(written)
  } catch (error) {
    logForDebugging(`Failed to save project config: ${error}`, {
      level: 'error',
    })
    // Fallback: try without lock
    try {
      const current = readStateFromDisk()
      const currentProjectConfig =
        current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
      const newProjectConfig = updater(currentProjectConfig)
      if (newProjectConfig === currentProjectConfig) return
      const written: GlobalConfig = {
        ...current,
        projects: { ...current.projects, [absolutePath]: newProjectConfig },
      }
      writeStateToDisk(written)
      writeThroughGlobalConfigCache(written)
    } catch {
      // Give up
    }
  } finally {
    release?.()
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * Returns true if plugin autoupdate should be skipped.
 * This checks if the auto-updater is disabled AND the FORCE_AUTOUPDATE_PLUGINS
 * env var is not set to 'true'. The env var allows forcing plugin autoupdate
 * even when the auto-updater is otherwise disabled.
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem is only a valid MemoryType when feature('TEAMMEM') is true
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // unreachable in external builds where TeamMem is not in MemoryType
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

// Exported for testing only
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
