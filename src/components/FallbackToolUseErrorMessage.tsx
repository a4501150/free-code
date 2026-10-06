import type { DomainToolResultBlockParam } from '../types/domain.js'
import * as React from 'react'
import { stripUnderlineAnsi } from 'src/components/shell/OutputLine.js'
import { extractTag } from 'src/utils/messages.js'
import { Box, Text } from '../ink.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { countCharInString } from '../utils/stringUtils.js'
import { MessageResponse } from './MessageResponse.js'

export const MAX_RENDERED_LINES = 10

type Props = {
  result: DomainToolResultBlockParam['content']
  verbose: boolean
  /** Collapsed line cap; defaults to MAX_RENDERED_LINES. */
  maxLines?: number
}

export function FallbackToolUseErrorMessage({
  result,
  verbose,
  maxLines = MAX_RENDERED_LINES,
}: Props): React.ReactNode {
  const transcriptShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
  )
  // MCP clients frame failures as "### Error\n<message>" and often echo a
  // prior "### Result" blob; the markdown markers are wire framing, not
  // something the reader needs. Stripping happens before the "Error: "
  // frame so a collapsed message starts at its real content.
  const stripMarkers = (text: string): string =>
    text.replace(/#{2,3} (?:Error|Result)\b[ \t]*/g, '').trim()

  let error: string

  if (typeof result !== 'string') {
    const text = Array.isArray(result)
      ? result
          .flatMap(b => (b?.type === 'text' ? [b.text] : []))
          .join('\n')
          .trim()
      : ''
    error = stripMarkers(text) || 'Tool execution failed'
  } else {
    const extractedError = extractTag(result, 'tool_use_error') ?? result
    // Strip <error> tags but keep their content (tags are for the model, not the UI)
    const withoutErrorTags = extractedError.replace(/<\/?error>/g, '')
    // The <tool_use_error> body is the source of truth shown to the model —
    // every variant names its remedy — so render it verbatim and only add the
    // "Error: " frame when the message does not carry one.
    const trimmed = stripMarkers(withoutErrorTags) || withoutErrorTags.trim()
    error =
      trimmed.startsWith('Error: ') ||
      trimmed.startsWith('Cancelled: ') ||
      trimmed.startsWith('Error calling tool')
        ? trimmed
        : `Error: ${trimmed}`
  }

  const plusLines = countCharInString(error, '\n') + 1 - maxLines

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">
          {stripUnderlineAnsi(
            verbose ? error : error.split('\n').slice(0, maxLines).join('\n'),
          )}
        </Text>
        {!verbose && plusLines > 0 && (
          // The careful <Text> layout is a workaround for the dim-bold
          // rendering bug
          <Box>
            <Text dimColor>
              … +{plusLines} {plusLines === 1 ? 'line' : 'lines'} (
            </Text>
            <Text dimColor bold>
              {transcriptShortcut}
            </Text>
            <Text> </Text>
            <Text dimColor>to see all)</Text>
          </Box>
        )}
      </Box>
    </MessageResponse>
  )
}
