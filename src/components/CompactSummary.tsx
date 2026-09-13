import * as React from 'react'
import { BLACK_CIRCLE } from '../constants/figures.js'
import { Box, Text } from '../ink.js'
import type { Screen } from '../types/repl.js'
import type { NormalizedUserMessage } from '../types/message.js'
import { getUserMessageText } from '../utils/messages.js'
import { MessageResponse } from './MessageResponse.js'

type Props = {
  message: NormalizedUserMessage
  screen: Screen
  /** Per-message click-to-expand (see expandedKeys in Messages.tsx). */
  verbose: boolean
}

export function CompactSummary({
  message,
  screen,
  verbose,
}: Props): React.ReactNode {
  const isTranscriptMode = screen === 'transcript'
  const textContent = getUserMessageText(message) || ''
  const metadata = message.summarizeMetadata
  // Body shows in transcript mode or when the row was clicked to expand;
  // the click hint only applies to the collapsible (non-transcript) view.
  const showBody = isTranscriptMode || verbose
  const expandHint = (
    <Text dimColor>
      {' '}
      {verbose ? '(click to collapse)' : '(click to expand)'}
    </Text>
  )

  // "Summarize from here" with metadata
  if (metadata) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Box minWidth={2}>
            <Text color="text">{BLACK_CIRCLE}</Text>
          </Box>
          <Box flexDirection="column">
            <Text bold>
              Summarized conversation
              {!showBody && expandHint}
            </Text>
            {!showBody && (
              <MessageResponse>
                <Box flexDirection="column">
                  <Text dimColor>
                    Summarized {metadata.messagesSummarized} messages{' '}
                    {metadata.direction === 'up_to'
                      ? 'up to this point'
                      : 'from this point'}
                  </Text>
                  {metadata.userContext && (
                    <Text dimColor>
                      Context: {'\u201c'}
                      {metadata.userContext}
                      {'\u201d'}
                    </Text>
                  )}
                </Box>
              </MessageResponse>
            )}
            {showBody && (
              <MessageResponse>
                <Text>{textContent}</Text>
              </MessageResponse>
            )}
          </Box>
        </Box>
      </Box>
    )
  }

  // Default compact summary (auto-compact)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color="text">{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>
            Compact summary
            {!showBody && expandHint}
          </Text>
        </Box>
      </Box>
      {showBody && (
        <MessageResponse>
          <Text>{textContent}</Text>
        </MessageResponse>
      )}
    </Box>
  )
}
