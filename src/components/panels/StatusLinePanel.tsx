import * as React from 'react'
import { memo } from 'react'

import { Ansi, Box, Text } from '../../ink.js'

type Props = {
  // Status-line output (undefined until the command has produced a result)
  text: string | undefined
  paddingX: number
}

/**
 * Host-agnostic renderer for the status line row. Data gathering — running
 * the statusline command, debouncing, cost/token subscriptions — lives in
 * the host (`components/StatusLine.tsx`); this panel only renders text.
 *
 * Must have stable height — the footer is flexShrink:0 so a 0→1 row change
 * when the command finishes steals a row from ScrollBox and shifts content.
 * Reserve the row while loading (same trick as PromptInputFooterLeftSide).
 */
function StatusLinePanelInner({ text, paddingX }: Props): React.ReactNode {
  return (
    <Box paddingX={paddingX} gap={2}>
      {text ? (
        <Text wrap="truncate">
          <Ansi>{text}</Ansi>
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  )
}

export const StatusLinePanel = memo(StatusLinePanelInner)
