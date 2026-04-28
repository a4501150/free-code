import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import { getProviderRegistry } from './model/providerRegistry.js'

export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

const DEFAULT_UNKNOWN_MODEL_COST: ModelCosts = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
}

// Fast mode pricing multiplier (6x normal pricing)
const FAST_MODE_MULTIPLIER = 6

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const registry = getProviderRegistry()
  const provider = registry.getProviderForModel(model)

  if (provider?.model.pricing) {
    const p = provider.model.pricing
    const base: ModelCosts = {
      inputTokens: p.input ?? DEFAULT_UNKNOWN_MODEL_COST.inputTokens,
      outputTokens: p.output ?? DEFAULT_UNKNOWN_MODEL_COST.outputTokens,
      promptCacheWriteTokens:
        p.cacheWrite ??
        (p.input ?? DEFAULT_UNKNOWN_MODEL_COST.inputTokens) * 1.25,
      promptCacheReadTokens:
        p.cacheRead ??
        (p.input ?? DEFAULT_UNKNOWN_MODEL_COST.inputTokens) * 0.1,
      webSearchRequests: p.webSearch ?? 0,
    }

    // Apply fast mode multiplier if applicable
    const isFastMode = usage.speed === 'fast'
    if (isFastModeEnabled() && isFastMode) {
      return {
        inputTokens: base.inputTokens * FAST_MODE_MULTIPLIER,
        outputTokens: base.outputTokens * FAST_MODE_MULTIPLIER,
        promptCacheWriteTokens:
          base.promptCacheWriteTokens * FAST_MODE_MULTIPLIER,
        promptCacheReadTokens:
          base.promptCacheReadTokens * FAST_MODE_MULTIPLIER,
        webSearchRequests: base.webSearchRequests,
      }
    }

    return base
  }

  setHasUnknownModelCost()
  return DEFAULT_UNKNOWN_MODEL_COST
}

// Calculate the cost of a query in US dollars.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 */
export function getModelPricingString(model: string): string | undefined {
  const registry = getProviderRegistry()
  const provider = registry.getProviderForModel(model)
  if (provider?.model.pricing) {
    const p = provider.model.pricing
    return formatModelPricing({
      inputTokens: p.input ?? 0,
      outputTokens: p.output ?? 0,
      promptCacheWriteTokens: p.cacheWrite ?? 0,
      promptCacheReadTokens: p.cacheRead ?? 0,
      webSearchRequests: p.webSearch ?? 0,
    })
  }
  return undefined
}
