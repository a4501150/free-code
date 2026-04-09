import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Message } from '../../types/message.js'

type Props = {
  message: Message
}

export function SnipBoundaryMessage(_props: Props): React.ReactNode {
  return (
    <Box>
      <Text dimColor>--- snip boundary ---</Text>
    </Box>
  )
}
