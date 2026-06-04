/**
 * Centralized migration utilities for Claude Code → Free Code.
 *
 * Three migration paths:
 *   1. Config directory migration: ~/.claude/ → ~/.freecode/
 *   2. Global config state migration: ~/.claude.json → ~/.freecode/state.json
 *   3. User settings migration: ~/.freecode/settings.json → ~/.freecode/freecode.json
 *
 * All migrations are user-consented or auto-detected during setup.
 * Settings loading is read-only and never triggers migration.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { safeParseJSON } from '../json.js'
import { synthesizeProvidersFromLegacy } from '../model/legacyProviderMigration.js'
import { stripContextSuffix } from '../model/parseModelString.js'
import { jsonStringify } from '../slowOperations.js'
import {
  orderFreecodeKeys,
  writeFreecodeSettingsFile,
} from './freecodeSettings.js'
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

// ── Global config state migration ───────────────────────────────────────

function getLegacyGlobalConfigPath(): string {
  return join(
    process.env.FREECODE_CONFIG_DIR ||
      process.env.CLAUDE_CONFIG_DIR ||
      homedir(),
    '.claude.json',
  )
}

export function needsGlobalConfigMigration(): boolean {
  if (!existsSync(getLegacyGlobalConfigPath())) return false
  const stateJsonPath = join(getClaudeConfigHomeDir(), 'state.json')
  return !existsSync(stateJsonPath)
}

export function migrateGlobalConfigToState(): void {
  const legacyPath = getLegacyGlobalConfigPath()
  if (!existsSync(legacyPath)) return

  let legacy: Record<string, unknown>
  try {
    const content = readFileSync(legacyPath, 'utf8')
    const parsed = safeParseJSON(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    legacy = parsed as Record<string, unknown>
  } catch {
    return
  }

  const STATE_KEYS = [
    'projects',
    'userID',
    'firstStartTime',
    'oauthAccount',
    'companion',
    'companionMuted',
    'customApiKeyResponses',
  ] as const

  const state: Record<string, unknown> = {}
  for (const key of STATE_KEYS) {
    if (key in legacy && legacy[key] !== undefined) {
      state[key] = legacy[key]
    }
  }

  if (Object.keys(state).length === 0) return

  const stateFile = join(getClaudeConfigHomeDir(), 'state.json')
  try {
    mkdirSync(dirname(stateFile), { recursive: true })
  } catch {
    // ignore
  }
  writeFileSyncAndFlush_DEPRECATED(
    stateFile,
    jsonStringify(state, null, 2) + '\n',
  )
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

  writeFreecodeSettingsFile(orderFreecodeKeys(out))
}
