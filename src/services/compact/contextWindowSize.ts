/**
 * Effective context window size — leaf module.
 *
 * Returns the usable context window for a model (context window minus the
 * tokens reserved for compact-summary output). Extracted from autoCompact.ts
 * so contextCollapse/index.ts can depend on it without closing the
 * autoCompact → contextCollapse cycle (the feature-full contextCollapse
 * build imports this helper).
 */

import { getSdkBetas } from '../../bootstrap/state.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from '../../utils/context.js'

// Reserve this many tokens for output during compaction.
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/** Context window size minus the max output tokens for the model. */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getModelMaxOutputTokens(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}
