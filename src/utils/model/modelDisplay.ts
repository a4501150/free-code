/**
 * Model display/presentation utilities.
 *
 * Pure functions that generate human-readable strings from model identifiers.
 * May import from modelResolution.ts but NOT vice versa.
 */

import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isCodexSubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getProviderRegistry } from './providerRegistry.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import type { ModelName, ModelSetting, ModelShortName } from './modelTypes.js'

// ── Canonical name resolution ──────────────────────────────────────

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Special cases for Claude 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-5 before 4)
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x models use a different naming scheme (claude-3-{family})
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  // OpenAI GPT models
  if (name.includes('gpt-5.4-mini')) {
    return 'gpt-5.4-mini'
  }
  if (name.includes('gpt-5.4')) {
    return 'gpt-5.4'
  }
  if (name.includes('gpt-5.3-codex')) {
    return 'gpt-5.3-codex'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// ── Display string generation ──────────────────────────────────────

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46
  )
}

export function getOpus46PricingSuffix(fastMode: boolean): string {
  if (!getProviderRegistry().getCapabilities().firstPartyFeatures) return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isCodexSubscriber()) {
    return 'GPT-5.3 Codex · Optimized for code generation and understanding'
  }
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    // Import lazily to avoid circular dep (isOpus1mMergeEnabled is in modelResolution)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isOpus1mMergeEnabled } = require('./modelResolution.js') as {
      isOpus1mMergeEnabled: () => boolean
    }
    if (isOpus1mMergeEnabled()) {
      return `Opus 4.6 with 1M context · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
    }
    return `Opus 4.6 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
  }
  return 'Sonnet 4.6 · Best for everyday tasks'
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 4.6 in plan mode, else Sonnet 4.6'
  }
  // Lazy require to avoid circular dep with modelResolution
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseUserSpecifiedModel } = require('./modelResolution.js') as {
    parseUserSpecifiedModel: (m: ModelName | ModelAlias) => ModelName
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  if (model.includes('gpt-') || model.includes('codex')) {
    if (model === 'gpt-5.2-codex') return 'Codex 5.2'
    if (model === 'gpt-5.1-codex') return 'Codex 5.1'
    if (model === 'gpt-5.1-codex-mini') return 'Codex 5.1 Mini'
    if (model === 'gpt-5.1-codex-max') return 'Codex 5.1 Max'
    if (model === 'gpt-5.4') return 'GPT 5.4'
    if (model === 'gpt-5.2') return 'GPT 5.2'
    return model
  }

  switch (model) {
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    case getModelStrings().gpt54:
      return 'GPT-5.4'
    case getModelStrings().gpt53codex:
      return 'GPT-5.3 Codex'
    case getModelStrings().gpt54mini:
      return 'GPT-5.4 Mini'
    default:
      return null
  }
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Claude {ModelName}" for publicly known models, or "Claude ({model})"
 * for unknown/internal models so the exact model name is preserved.
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    if (model.includes('gpt-') || model.includes('codex')) {
      return publicName
    }
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    // Lazy require to avoid circular dep with modelResolution
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDefaultMainLoopModel } = require('./modelResolution.js') as {
      getDefaultMainLoopModel: () => ModelName
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseUserSpecifiedModel } = require('./modelResolution.js') as {
    parseUserSpecifiedModel: (m: ModelName | ModelAlias) => ModelName
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getProviderRegistry().getCapability(modelId, 'opaqueDeploymentIds')) {
    // deployment ID is user-defined (e.g. Foundry), so it may have no relation to the actual model
    return undefined
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }
  // OpenAI Codex models
  if (canonical.includes('gpt-5.4-mini')) {
    return 'GPT-5.4 Mini'
  }
  if (canonical.includes('gpt-5.4')) {
    return 'GPT-5.4'
  }
  if (canonical.includes('gpt-5.3-codex')) {
    return 'GPT-5.3 Codex'
  }

  return undefined
}
