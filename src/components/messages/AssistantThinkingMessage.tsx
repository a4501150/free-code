import type {
  ThinkingBlock,
  ThinkingBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'

type Props = {
  param:
    | ThinkingBlock
    | ThinkingBlockParam
    | { type: 'thinking'; thinking: string }
    | { type: 'reasoning'; text: string }
  addMargin: boolean
  isTranscriptMode: boolean
  verbose: boolean
  /** When true, hide this thinking block entirely (used for past thinking in transcript mode) */
  hideInTranscript?: boolean
}

export function AssistantThinkingMessage({
  param,
  addMargin = false,
  isTranscriptMode,
  verbose,
  hideInTranscript = false,
}: Props): React.ReactNode {
  const thinking =
    'thinking' in param ? param.thinking : (param as { text: string }).text
  if (!thinking) {
    return null
  }

  if (hideInTranscript) {
    return null
  }

  const shouldShowFullThinking = isTranscriptMode || verbose
  const label = '∴ Thinking'

  if (!shouldShowFullThinking) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <Text dimColor italic>
          {label} <CtrlOToExpand />
        </Text>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      gap={1}
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      <Text dimColor italic>
        {label}…
      </Text>
      <Box paddingLeft={2}>
        <Markdown dimColor>{thinking}</Markdown>
      </Box>
    </Box>
  )
}
