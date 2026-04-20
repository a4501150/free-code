// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isEnvTruthy } from './envUtils.js'
import { getModelCapability } from './model/modelCapabilities.js'
import { getProviderRegistry } from './model/providerRegistry.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens — used as fallback inside
// getModelMaxOutputTokens when the provider registry has no per-model info.
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000

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
  const resolved = getProviderRegistry().getProviderForModel(model)
  if (resolved?.model.contextWindow !== undefined) {
    return resolved.model.contextWindow >= 1_000_000
  }
  return false
}

export function getContextWindowForModel(
  model: string,
  _betas?: string[],
): number {
  // Per-model contextWindow from freecode.json takes priority
  const resolved = getProviderRegistry().getProviderForModel(model)
  if (resolved?.model.contextWindow && resolved.model.contextWindow > 0) {
    if (is1mContextDisabled() && resolved.model.contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return resolved.model.contextWindow
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
 * Returns the `max_tokens` value to send to the API for this model.
 * Resolution order:
 *   1. CLAUDE_CODE_MAX_OUTPUT_TOKENS env (unclamped positive int)
 *   2. freecode.json providerConfig.model.maxOutputTokens
 *   3. Model capability table (clamped to MAX_OUTPUT_TOKENS_DEFAULT)
 *   4. MAX_OUTPUT_TOKENS_DEFAULT fallback
 */
export function getModelMaxOutputTokens(model: string): number {
  const envOverride = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  if (envOverride) {
    const n = Number.parseInt(envOverride, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  const resolved = getProviderRegistry().getProviderForModel(model)
  if (resolved?.model.maxOutputTokens && resolved.model.maxOutputTokens > 0) {
    return resolved.model.maxOutputTokens
  }
  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    return Math.min(MAX_OUTPUT_TOKENS_DEFAULT, cap.max_tokens)
  }
  return MAX_OUTPUT_TOKENS_DEFAULT
}

/**
 * Returns the max thinking budget tokens for a given model.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model) - 1
}
