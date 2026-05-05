/**
 * Effective context window size — leaf module.
 *
 * Returns the usable context window for a model (context window minus the
 * tokens reserved for compact-summary output).
 */

import { getSdkBetas } from '../../bootstrap/state.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from '../../utils/context.js'

// Reserve this many tokens for output during compaction.
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export function getConfiguredContextWindowSize(model: string): number {
  return getContextWindowForModel(model, getSdkBetas())
}

/** Context window size minus the max output tokens for the model. */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getModelMaxOutputTokens(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return getConfiguredContextWindowSize(model) - reservedTokensForSummary
}
