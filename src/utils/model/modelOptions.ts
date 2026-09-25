// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { formatModelPricing } from '../modelCost.js'
import { getProviderRegistry } from './providerRegistry.js'
import {
  getClaudeAiUserDefaultModelDescription,
  getDefaultMainLoopModelSetting,
  getPublicModelDisplayName,
  getUserSpecifiedModelSetting,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { isClaudeAISubscriber } from '../auth.js'
import type { ProviderModelConfig } from '../settings/types.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

/**
 * Build the "Default (recommended)" option shown at the top of the picker.
 */
function getDefaultOptionForUser(): ModelOption {
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(),
    }
  }

  // PAYG — show the resolved default model and pricing
  const registry = getProviderRegistry()
  const defaultModelId = getDefaultMainLoopModelSetting()
  const resolved = registry.getProviderForModel(defaultModelId)
  const pricingSuffix = resolved?.model.pricing
    ? ` · ${formatModelPricing({ inputTokens: resolved.model.pricing.input ?? 0, outputTokens: resolved.model.pricing.output ?? 0, promptCacheWriteTokens: resolved.model.pricing.cacheWrite ?? 0, promptCacheReadTokens: resolved.model.pricing.cacheRead ?? 0, webSearchRequests: resolved.model.pricing.webSearch ?? 0 })}`
    : ''

  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(defaultModelId)})${pricingSuffix}`,
  }
}

/**
 * Format a context window size as a short tag for the model picker label.
 * E.g. 1_000_000 → "(1M)", 200_000 → "(200k)", 0/undefined → "".
 */
function formatContextWindowTag(contextWindow?: number): string {
  if (!contextWindow || contextWindow <= 0) return ''
  if (contextWindow >= 1_000_000) {
    const m = contextWindow / 1_000_000
    return `(${Number.isInteger(m) ? m : m.toFixed(1)}M)`
  }
  if (contextWindow >= 1_000) {
    const k = contextWindow / 1_000
    return `(${Number.isInteger(k) ? k : k.toFixed(0)}k)`
  }
  return `(${contextWindow})`
}

/**
 * Build a pricing suffix string from provider model pricing metadata.
 * Returns empty string when the model has no pricing data, whatever provider
 * it belongs to.
 */
function buildPricingSuffix(model: ProviderModelConfig): string {
  if (!model.pricing) return ''
  return ` · ${formatModelPricing({
    inputTokens: model.pricing.input ?? 0,
    outputTokens: model.pricing.output ?? 0,
    promptCacheWriteTokens: model.pricing.cacheWrite ?? 0,
    promptCacheReadTokens: model.pricing.cacheRead ?? 0,
    webSearchRequests: model.pricing.webSearch ?? 0,
  })}`
}

/**
 * Build a ModelOption from a provider model config.
 */
function buildModelOption(
  model: ProviderModelConfig,
  providerName: string,
): ModelOption {
  const ctxTag = formatContextWindowTag(model.contextWindow)
  const label = (model.label || model.id) + (ctxTag ? ` ${ctxTag}` : '')
  const desc = model.description || model.id
  const pricing = buildPricingSuffix(model)

  // Label is shown in its own column; description carries the text plus
  // pricing when the model has pricing data (provider name is the tab header).
  const description = `${desc}${pricing}`

  // descriptionForModel is used in the system prompt (no pricing, plain text)
  const descriptionForModel = model.description
    ? `${label} - ${model.description}`
    : undefined

  return {
    value: `${providerName}:${model.id}`,
    label,
    description,
    descriptionForModel,
  }
}

/**
 * Returns a ModelOption for a known model with a human-readable label.
 * Returns null if the model has no display name.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const displayName = getPublicModelDisplayName(model)
  if (!displayName) return null

  return {
    value: model,
    label: displayName,
    description: model,
  }
}

/**
 * Return a flat list of all model options. Used by print.
 */
export function getModelOptions(fastMode = false): ModelOption[] {
  return getGroupedModelOptions(fastMode).flatMap(g => g.options)
}

export type ModelOptionGroup = {
  provider: string
  options: ModelOption[]
}

/**
 * Return model options grouped by provider. All groups are built purely from
 * the provider registry (freecode.json providers, populated by login or
 * legacy migration).
 */
export function getGroupedModelOptions(_fastMode = false): ModelOptionGroup[] {
  const registry = getProviderRegistry()
  const allProviders = registry.getAllProviders()
  const groups: ModelOptionGroup[] = []
  let isFirstGroup = true

  for (const [providerName, providerConfig] of allProviders) {
    const options: ModelOption[] = []

    // Prepend "Default (recommended)" to the first group
    if (isFirstGroup) {
      options.push(getDefaultOptionForUser())
      isFirstGroup = false
    }

    for (const model of providerConfig.models) {
      options.push(buildModelOption(model, providerName))
    }

    if (options.length > 0) {
      groups.push({
        provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
        options,
      })
    }
  }

  // If no providers at all, create a minimal group with just the default
  if (groups.length === 0) {
    groups.push({
      provider: 'Anthropic',
      options: [getDefaultOptionForUser()],
    })
  }

  const firstGroup = groups[0]!

  // --- handle custom model (from --model or settings) ---
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }

  if (customModel !== null) {
    const allOpts = groups.flatMap(g => g.options)
    if (!allOpts.some(o => o.value === customModel)) {
      const knownOption = getKnownModelOption(customModel)
      firstGroup.options.push(
        knownOption ?? {
          value: customModel,
          label: customModel,
          description: 'Custom model',
        },
      )
    }
  }

  return groups.filter(g => g.options.length > 0)
}
