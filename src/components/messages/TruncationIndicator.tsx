import * as React from 'react'
import { Text } from '../../ink.js'
import { MessageResponse } from '../MessageResponse.js'

/**
 * Dim one-line footer rendered below an assistant message whose turn ended
 * with `stop_reason: max_tokens` or `stop_reason: model_context_window_exceeded`.
 *
 * The harness no longer injects a synthetic "API Error: ..." assistant turn
 * into the conversation history for these stops (see Issue 1 in the
 * "harness second-guessing" fix). The real assistant message still carries
 * its partial content; this indicator surfaces the stop reason to the user
 * without lying to the model.
 *
 * UI-only — never enters the conversation history, never sent back to the
 * model.
 */
export function TruncationIndicator({
  stopReason,
}: {
  stopReason: 'max_tokens' | 'model_context_window_exceeded'
}): React.ReactNode {
  const label =
    stopReason === 'max_tokens'
      ? 'max_output_tokens reached'
      : 'context window exceeded'
  return (
    <MessageResponse height={1}>
      <Text color="error" dimColor>
        ⚠ Response truncated: {label}. Raise `maxOutputTokens` in freecode.json
        to continue.
      </Text>
    </MessageResponse>
  )
}
