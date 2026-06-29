/**
 * Centralized migration utilities for Claude Code → Free Code.
 *
 * Two migration paths:
 *   1. Config directory migration: ~/.claude/ → ~/.freecode/
 *   2. User settings migration: ~/.freecode/settings.json → ~/.freecode/freecode.json
 *
 * All migrations are user-consented or auto-detected during setup.
 * Settings loading is read-only and never triggers migration.
 */

import { cpSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { synthesizeProvidersFromLegacy } from '../model/legacyProviderMigration.js'
import { stripContextSuffix } from '../model/parseModelString.js'
import {
  orderFreecodeKeys,
  writeFreecodeSettingsFile,
} from './freecodeSettings.js'
import { writeModelSettingsFile } from './modelSettings.js'
import { MODEL_SETTINGS_KEYS } from './modelSettingsKeys.js'
import { normalizeAutoModeSetting } from './types.js'

// ── Config directory migration ──────────────────────────────────────────

export function getFreecodeConfigDir(): string {
  return join(homedir(), '.freecode')
}

export function getLegacyClaudeConfigDir(): string {
  return join(homedir(), '.claude')
}

export function needsConfigDirMigration(): boolean {
  return (
    !existsSync(getClaudeConfigHomeDir()) &&
    existsSync(getLegacyClaudeConfigDir()) &&
    !process.env.FREECODE_CONFIG_DIR &&
    !process.env.CLAUDE_CONFIG_DIR
  )
}

export function copyConfigDir(
  src: string,
  dst: string,
): { src: string; dst: string } {
  cpSync(src, dst, { recursive: true })
  return { src, dst }
}

export function migrateToFreecodeDir(): void {
  copyConfigDir(getLegacyClaudeConfigDir(), getClaudeConfigHomeDir())
}

// ── User CLAUDE.md migration (~/.claude/CLAUDE.md → <config home>/CLAUDE.md) ──

export function getUserLegacyClaudeMdPath(): string {
  return join(getLegacyClaudeConfigDir(), 'CLAUDE.md')
}

export function getUserPreferredClaudeMdPath(): string {
  return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
}

// True when the legacy ~/.claude/CLAUDE.md exists but the preferred
// config-home CLAUDE.md does not, and no custom config dir is in use. Callers
// suppress re-prompts after the user has decided (see showSetupScreens).
export function needsUserClaudeMdMigration(): boolean {
  if (process.env.FREECODE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR) {
    return false
  }
  return (
    existsSync(getUserLegacyClaudeMdPath()) &&
    !existsSync(getUserPreferredClaudeMdPath())
  )
}

export function migrateUserClaudeMd(): void {
  cpSync(getUserLegacyClaudeMdPath(), getUserPreferredClaudeMdPath())
}

// ── User settings migration ─────────────────────────────────────────────

const CONSUMED_ENV_VARS: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
]

function legacySettingsPath(): string {
  return join(getClaudeConfigHomeDir(), 'settings.json')
}

export function legacySettingsFileExists(): boolean {
  return existsSync(legacySettingsPath())
}

function readLegacySettings(): Record<string, unknown> | null {
  if (!legacySettingsFileExists()) return null
  try {
    const parsed = safeParseJSON(readFileSync(legacySettingsPath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Non-fatal
  }
  return null
}

function readGlobalClaudeJson(): Record<string, unknown> | null {
  const configPath = join(
    process.env.FREECODE_CONFIG_DIR ||
      process.env.CLAUDE_CONFIG_DIR ||
      homedir(),
    '.claude.json',
  )
  if (!existsSync(configPath)) return null
  try {
    const parsed = safeParseJSON(readFileSync(configPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Non-fatal
  }
  return null
}

export function runLegacyToFreecodeMigration(): void {
  const legacy = readLegacySettings()
  const globalJson = readGlobalClaudeJson()
  const legacyEnv = (legacy?.env ?? {}) as Record<string, string | undefined>

  const out: Record<string, unknown> = { ...(legacy ?? {}) }
  delete out.model

  const {
    providers,
    defaultModel,
    defaultSubagentModel,
    defaultSmallFastModel,
  } = synthesizeProvidersFromLegacy({
    env: { ...process.env, ...legacyEnv },
  })

  if (defaultModel && !out.defaultModel) out.defaultModel = defaultModel
  if (defaultSubagentModel && !out.defaultSubagentModel)
    out.defaultSubagentModel = defaultSubagentModel
  if (defaultSmallFastModel && !out.defaultSmallFastModel)
    out.defaultSmallFastModel = defaultSmallFastModel

  if (!out.defaultModel && typeof legacy?.model === 'string') {
    const defaultProviderName = Object.keys(providers)[0] ?? 'anthropic'
    const bare = stripContextSuffix(legacy.model)
    out.defaultModel = bare.includes(':')
      ? bare
      : `${defaultProviderName}:${bare}`
  }

  const env = { ...((out.env as Record<string, string> | undefined) ?? {}) }
  for (const key of CONSUMED_ENV_VARS) {
    delete env[key]
  }
  if (Object.keys(env).length > 0) {
    out.env = env
  } else {
    delete out.env
  }

  const autoMode = normalizeAutoModeSetting(out.autoMode)
  if (autoMode && typeof autoMode === 'object' && !Array.isArray(autoMode)) {
    out.autoMode = {
      ...autoMode,
      ...(typeof out.autoModeClassifierModel === 'string'
        ? { classifierModel: out.autoModeClassifierModel }
        : {}),
    }
  } else if (typeof out.autoModeClassifierModel === 'string') {
    out.autoMode = { classifierModel: out.autoModeClassifierModel }
  }
  delete out.autoModeClassifierModel

  if (!out.mcpServers) {
    const mcpServers = globalJson?.mcpServers
    if (
      mcpServers &&
      typeof mcpServers === 'object' &&
      Object.keys(mcpServers as Record<string, unknown>).length > 0
    ) {
      out.mcpServers = mcpServers
    }
  }

  out.providers = providers

  // Split output: model keys go to modelSettings.json, rest to freecode.json
  const modelOut: Record<string, unknown> = {}
  const generalOut: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(out)) {
    if (MODEL_SETTINGS_KEYS.has(key)) {
      modelOut[key] = value
    } else {
      generalOut[key] = value
    }
  }

  if (Object.keys(modelOut).length > 0) {
    writeModelSettingsFile(modelOut)
  }
  if (Object.keys(generalOut).length > 0) {
    writeFreecodeSettingsFile(orderFreecodeKeys(generalOut))
  }
}
