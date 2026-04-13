/**
 * Model resolution utilities.
 *
 * Determines which model to use based on user settings, subscription tier,
 * environment variables, and provider configuration. Pure resolution logic —
 * no display string generation (that lives in modelDisplay.ts).
 */

import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isCodexSubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings } from './modelStrings.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getProviderRegistry } from './providerRegistry.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import type { ModelName, ModelSetting } from './modelTypes.js'
import {
  parseModelStringFromRegistry,
  qualifyModel,
  toQualifiedString,
} from './parseModelString.js'

// Re-export types from modelTypes for backward compat
export type { ModelShortName, ModelName, ModelSetting } from './modelTypes.js'

export function getSmallFastModel(): ModelName {
  if (process.env.ANTHROPIC_SMALL_FAST_MODEL) {
    return qualifyWithDefault(process.env.ANTHROPIC_SMALL_FAST_MODEL)
  }
  return getDefaultHaikuModel()
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

/**
 * Helper to qualify a bare model ID with the default provider name.
 * If the model is already qualified, returns it as-is.
 * Strips any context suffix ([1m], [2m]) — callers that need a suffix add it themselves.
 */
function qualifyWithDefault(bareModelId: string): ModelName {
  const registry = getProviderRegistry()
  const parsed = parseModelStringFromRegistry(bareModelId)
  // Use the parsed provider if it was explicitly qualified, otherwise use default
  const provider = parsed.provider || registry.getDefaultProviderName() || ''
  // Return without context suffix — getDefaultXxxModel() returns base model IDs
  return qualifyModel(provider, parsed.modelId)
}

// @[MODEL LAUNCH]: Update default model IDs below if the new model becomes the default.
export function getDefaultOpusModel(): ModelName {
  return qualifyWithDefault(getModelStrings().opus46)
}

export function getDefaultSonnetModel(): ModelName {
  return qualifyWithDefault(getModelStrings().sonnet46)
}

export function getDefaultHaikuModel(): ModelName {
  return qualifyWithDefault(getModelStrings().haiku45)
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan uses Opus in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // sonnetplan by default
  if (
    getUserSpecifiedModelSetting() === 'haiku' &&
    permissionMode === 'plan'
  ) {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting.
 *
 * This handles the built-in default:
 * - Opus for Max and Team Premium users
 * - Sonnet 4.6 for all other users (including Team Standard, Pro, Enterprise)
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  if (isCodexSubscriber()) {
    return qualifyWithDefault(getModelStrings().gpt53codex)
  }

  // Max users get Opus as default
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get Sonnet as default
  // Note that PAYG (3P) may default to an older Sonnet model
  return getDefaultSonnetModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    !getProviderRegistry().getCapabilities().firstPartyFeatures
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown.
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

/**
 * Returns a fully-qualified model name for use in this session, after
 * resolving aliases and ensuring a provider prefix is present.
 *
 * All model strings in the system are provider-qualified: "provider:modelId[contextSuffix]".
 * Bare aliases ("sonnet", "opus", "haiku") resolve using the default provider.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const parsed = parseModelStringFromRegistry(modelInput)
  const modelString = parsed.modelId.toLowerCase()
  const suffix = parsed.contextSuffix
  const has1mTag = suffix.toLowerCase() === '[1m]'

  // Resolve built-in aliases — getDefaultXxxModel() already returns qualified strings
  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        return getDefaultSonnetModel() + suffix // Sonnet is default, Opus in plan mode
      case 'sonnet':
        return getDefaultSonnetModel() + suffix
      case 'haiku':
        return getDefaultHaikuModel() + suffix
      case 'opus':
        return getDefaultOpusModel() + suffix
      case 'best':
        return getBestModel()
      default:
    }
  }

  // Check provider registry for alias match (covers custom providers)
  const registry = getProviderRegistry()
  const qualifiedInput = toQualifiedString(parsed)
  const registryMatch = registry.getProviderForModel(qualifiedInput)
  if (registryMatch && registryMatch.model.alias === parsed.modelId) {
    return qualifyModel(registryMatch.providerName, registryMatch.model.id, suffix)
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // Claude.ai) — silently remap to the current Opus default.
  if (
    getProviderRegistry().getCapabilities().firstPartyFeatures &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + suffix
  }

  // Return the qualified string, preserving original case for custom model
  // names (e.g., Azure Foundry deployment IDs)
  return qualifyModel(parsed.provider, parsed.modelId, suffix)
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  const resolved = parseUserSpecifiedModel(skillModel)
  if (modelSupports1M(resolved)) {
    // Append [1m] to the qualified string
    const parsed = parseModelStringFromRegistry(resolved)
    return qualifyModel(parsed.provider, parsed.modelId, '[1m]')
  }
  return skillModel
}

export function normalizeModelStringForAPI(model: string): string {
  return parseModelStringFromRegistry(model).modelId
}

/**
 * Opt-out for the legacy Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

// ── Private helpers ────────────────────────────────────────────────

const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}
