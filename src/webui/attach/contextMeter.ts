import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompactConfig.js'
import type { Message } from '../../types/message.js'
import {
  calculateContextPercentages,
  getContextWindowForModel,
} from '../../utils/context.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import {
  getCurrentUsage,
  tokenCountFromLastAPIResponse,
} from '../../utils/tokens.js'
import type { WebSessionContext } from '../protocol/attachSchemas.js'

/**
 * The context budget, measured the two ways the TUI measures it.
 *
 * `usedTokens` and `usedPercent` follow the statusline: the last API response's
 * input context, cache included and output excluded, against the model window.
 * `compactPercentLeft` follows the token warning instead, which counts output
 * too and measures against the auto-compact threshold rather than the window.
 * They are different numbers on purpose, so each one is computed the way its
 * own surface computes it.
 *
 * Returns undefined before the first API response, when there is nothing to
 * report rather than zero to report.
 */
export function buildContextMeter(
  messages: readonly Message[],
  model: string | undefined,
): WebSessionContext | undefined {
  if (!model) return undefined

  const afterBoundary = getMessagesAfterCompactBoundary(messages as Message[])
  const usage = getCurrentUsage(afterBoundary)
  if (!usage) return undefined

  const maxTokens = getContextWindowForModel(model)
  const { used } = calculateContextPercentages(usage, maxTokens)
  if (used === null) return undefined

  const usedTokens =
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens

  return {
    usedTokens,
    maxTokens,
    usedPercent: used,
    // Absent when auto-compact is off, because then nothing will compact and
    // "until auto-compact" would describe an event that never arrives.
    compactPercentLeft: isAutoCompactEnabled()
      ? calculateTokenWarningState(
          tokenCountFromLastAPIResponse(afterBoundary),
          model,
        ).percentLeft
      : undefined,
  }
}
