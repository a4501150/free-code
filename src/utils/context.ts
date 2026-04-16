// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isEnvTruthy } from './envUtils.js'
import { getModelCapability } from './model/modelCapabilities.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the betas→context import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Config-driven: check registry for contextWindow >= 1M
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProviderRegistry } = require('./model/providerRegistry.js') as {
      getProviderRegistry: () => { getProviderForModel: (m: string) => { model: { contextWindow?: number } } | null }
    }
    const resolved = getProviderRegistry().getProviderForModel(model)
    if (resolved?.model.contextWindow !== undefined) {
      return resolved.model.contextWindow >= 1_000_000
    }
  } catch {
    // Registry not available yet
  }
  return false
}

export function getContextWindowForModel(
  model: string,
  _betas?: string[],
): number {
  // Per-model contextWindow from freecode.json takes priority
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProviderRegistry } = require('./model/providerRegistry.js') as {
      getProviderRegistry: () => { getProviderForModel: (m: string) => { model: { contextWindow?: number } } | null }
    }
    const resolved = getProviderRegistry().getProviderForModel(model)
    if (resolved?.model.contextWindow && resolved.model.contextWindow > 0) {
      if (is1mContextDisabled() && resolved.model.contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT) {
        return MODEL_CONTEXT_WINDOW_DEFAULT
      }
      return resolved.model.contextWindow
    }
  } catch {
    // Registry not available yet — fall through to defaults
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 * Uses registry metadata, falls back to safe defaults.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  // Per-model maxOutputTokens from freecode.json takes priority
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProviderRegistry } = require('./model/providerRegistry.js') as {
      getProviderRegistry: () => { getProviderForModel: (m: string) => { model: { maxOutputTokens?: number; maxOutputTokensDefault?: number } } | null }
    }
    const resolved = getProviderRegistry().getProviderForModel(model)
    if (resolved?.model.maxOutputTokens && resolved.model.maxOutputTokens > 0) {
      const upperLimit = resolved.model.maxOutputTokens
      const defaultTokens = resolved.model.maxOutputTokensDefault ?? upperLimit
      return { default: defaultTokens, upperLimit }
    }
  } catch {
    // Registry not available yet — fall through to defaults
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    return { default: Math.min(MAX_OUTPUT_TOKENS_DEFAULT, cap.max_tokens), upperLimit: cap.max_tokens }
  }

  return { default: MAX_OUTPUT_TOKENS_DEFAULT, upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT }
}

/**
 * Returns the max thinking budget tokens for a given model.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
