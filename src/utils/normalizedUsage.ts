/**
 * Provider-agnostic usage accounting.
 *
 * In-process representation of token usage, replacing direct reads of the
 * Anthropic SDK's snake_case `BetaUsage` at business-logic call sites.
 *
 * Semantic contract:
 *   - `undefined` on an optional field means "provider does not report /
 *     distinguish this metric". UI code should hide the column.
 *   - `0` means "provider reports and the value is genuinely zero". UI code
 *     should show a 0.
 *
 * The Anthropic SDK type is still used at the wire boundary (adapter
 * responses, streaming deltas, external SDK types). Conversion from the
 * provider-native shape to Anthropic-shape happens at the wire-level SSE
 * translator in each `src/services/api/*-adapter.ts`; conversion from that
 * Anthropic-shape `BetaUsage` to {@link NormalizedUsage} happens via
 * {@link fromAnthropicUsage}.
 */
import type { Anthropic } from '@anthropic-ai/sdk'
import type { ProviderType } from './settings/types.js'

export type NormalizedUsage = {
  /** Marginal (non-cached) input tokens billed at full rate. */
  inputTokens: number
  /** Output tokens (may include reasoning when the provider bundles them). */
  outputTokens: number
  /**
   * Reasoning / thinking tokens — separate when the provider distinguishes,
   * otherwise undefined. For Anthropic these are bundled into outputTokens.
   */
  reasoningTokens?: number
  /**
   * Input tokens served from provider cache. Undefined when the provider
   * does not report cache reads.
   */
  cacheReadTokens?: number
  /**
   * Input tokens written to cache this turn. Undefined (not 0) when the
   * provider does not distinguish write cost (e.g. OpenAI automatic prefix
   * caching; Gemini unless using explicit cachedContent). 0 only when the
   * provider reports write cost and it is genuinely zero.
   */
  cacheWriteTokens?: number
  /** Provider-native usage blob for escape-hatch display. */
  raw: unknown
  /** Source provider, for later cross-provider reconciliation. */
  sourceProvider?: ProviderType
}

/** Sum `a + b` field-wise; preserves `undefined` iff both sides are undefined. */
function addOptional(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

/**
 * Used by context-window fill calculations. Equivalent to today's
 * getInputTokensUsed() — inputTokens + cacheReadTokens + cacheWriteTokens,
 * treating undefined cache fields as 0 for summation purposes.
 */
export function totalInputTokens(u: NormalizedUsage): number {
  return u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
}

/**
 * Sum operator for session-cumulative totals. Preserves `undefined` on
 * optional fields unless either side defines a value.
 *
 * `raw` is dropped (it's the provider-native blob from a specific turn, not
 * a cumulative sum). `sourceProvider` is kept from `a` (arbitrary but
 * consistent).
 */
export function addUsage(
  a: NormalizedUsage,
  b: NormalizedUsage,
): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: addOptional(a.reasoningTokens, b.reasoningTokens),
    cacheReadTokens: addOptional(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: addOptional(a.cacheWriteTokens, b.cacheWriteTokens),
    raw: null,
    sourceProvider: a.sourceProvider,
  }
}

/**
 * Zero-initialized usage for accumulators. Cache fields are `undefined`
 * until an actual response updates them.
 */
export function emptyNormalizedUsage(
  sourceProvider?: ProviderType,
): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    raw: null,
    sourceProvider,
  }
}

/**
 * Bridge from the Anthropic SDK's BetaUsage shape into NormalizedUsage.
 *
 * The Anthropic API always populates `cache_creation_input_tokens` and
 * `cache_read_input_tokens` (as 0 when not cached), so we preserve them
 * as concrete numbers here rather than collapsing to undefined.
 */
export function fromAnthropicUsage(
  u: Anthropic.Beta.Messages.BetaUsage,
  sourceProvider: ProviderType = 'anthropic',
): NormalizedUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: u.cache_creation_input_tokens ?? undefined,
    raw: u,
    sourceProvider,
  }
}
