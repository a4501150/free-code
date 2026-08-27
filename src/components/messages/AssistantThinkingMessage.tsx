import type { DomainReasoningBlock } from '../../types/domain.js'
import React from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'
import { formatSecondsShort } from '../../utils/format.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

type Props = {
  param: DomainReasoningBlock | { type: 'thinking'; thinking: string }
  addMargin: boolean
  isTranscriptMode: boolean
  verbose: boolean
  isStreaming?: boolean
  durationMs?: number
}

export function AssistantThinkingMessage({
  param,
  addMargin = false,
  isTranscriptMode,
  verbose,
  isStreaming = false,
  durationMs,
}: Props): React.ReactNode {
  const thinking =
    'thinking' in param ? param.thinking : (param as { text: string }).text

  const hasOpaqueReasoning =
    'providerState' in param &&
    !!(param.providerState?.openaiResponses?.encryptedContent ||
      param.providerState?.bedrockConverse?.redactedContent)

  if (!thinking && !isStreaming) {
    if (!hasOpaqueReasoning) {
      return null
    }
    const opaqueLabel =
      durationMs !== undefined
        ? `\u2234 thought for ${formatSecondsShort(durationMs)}`
        : '\u2234 thought'
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <Text dimColor italic>
          {opaqueLabel}
        </Text>
      </Box>
    )
  }

  const shouldShowFullThinking = isTranscriptMode || verbose

  const label = isStreaming
    ? '∴ thinking'
    : durationMs !== undefined
      ? `∴ thought for ${formatSecondsShort(durationMs)}`
      : '∴ thought'

  if (!shouldShowFullThinking) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        {isStreaming ? (
          <ThinkingAnimation />
        ) : (
          <Text dimColor italic>
            {label} <CtrlOToExpand />
          </Text>
        )}
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
      {isStreaming ? (
        <ThinkingAnimation />
      ) : (
        <Text dimColor italic>
          {label}
        </Text>
      )}
      {thinking && (
        <Box paddingLeft={2}>
          <Markdown dimColor>{thinking}</Markdown>
        </Box>
      )}
    </Box>
  )
}

const GLYPH_CYCLE = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠇']

function ThinkingAnimation(): React.ReactNode {
  const reducedMotion = getInitialSettings().prefersReducedMotion ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 120)

  if (reducedMotion) {
    return (
      <Box ref={ref}>
        <Text dimColor italic>
          ∴ thinking
        </Text>
      </Box>
    )
  }

  const glyph = GLYPH_CYCLE[Math.floor(time / 150) % GLYPH_CYCLE.length]!

  return (
    <Box ref={ref}>
      <Text dimColor italic>
        {glyph} thinking
      </Text>
    </Box>
  )
}
