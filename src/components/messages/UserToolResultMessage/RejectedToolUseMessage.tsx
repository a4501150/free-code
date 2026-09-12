import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { MessageResponse } from '../../MessageResponse.js'

export function RejectedToolUseMessage({
  reason,
}: {
  reason?: string
}): React.ReactNode {
  return (
    <MessageResponse height={reason ? undefined : 1}>
      <Box flexDirection="column">
        <Text dimColor>Tool use rejected</Text>
        {reason && (
          <Text dimColor italic>
            User said: {reason}
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}
