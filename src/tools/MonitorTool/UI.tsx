import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { MonitorOut, MonitorToolInput } from './MonitorTool.js'

export function renderToolUseMessage(
  input: Partial<MonitorToolInput>,
): React.ReactNode {
  const label = input.description ?? input.command ?? ''
  return `Starting monitor: ${label}`
}

export function renderToolResultMessage(output: MonitorOut): React.ReactNode {
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>Monitor started (id: {output.monitorTaskId})</Text>
        {output.stdout ? <Text dimColor>{output.stdout}</Text> : null}
      </Box>
    </MessageResponse>
  )
}
