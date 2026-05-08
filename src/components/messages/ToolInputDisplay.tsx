import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../MessageResponse.js'

const MAX_VALUE_LENGTH = 200
const MAX_PARAMS = 8

function truncateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }
  if (typeof value === 'string') {
    if (value.length <= MAX_VALUE_LENGTH) {
      return value.includes('\n')
        ? value.split('\n')[0]! + `  ...+${value.split('\n').length - 1} lines`
        : value
    }
    const first = value.slice(0, MAX_VALUE_LENGTH)
    const firstLine = first.includes('\n') ? first.split('\n')[0]! : first
    return firstLine + `  ...+${value.length - firstLine.length} chars`
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value)
  }
  const json = JSON.stringify(value)
  if (json.length <= MAX_VALUE_LENGTH) {
    return json
  }
  return (
    json.slice(0, MAX_VALUE_LENGTH) +
    `  ...+${json.length - MAX_VALUE_LENGTH} chars`
  )
}

type Props = {
  input: Record<string, unknown>
}

export function ToolInputDisplay({ input }: Props): React.ReactNode {
  const entries = Object.entries(input)
  if (entries.length === 0) {
    return null
  }

  const visible = entries.slice(0, MAX_PARAMS)
  const remaining = entries.length - visible.length

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {visible.map(([key, value]) => (
          <Text key={key} dimColor wrap="truncate-end">
            {key}: {truncateValue(value)}
          </Text>
        ))}
        {remaining > 0 && <Text dimColor>...+{remaining} more params</Text>}
      </Box>
    </MessageResponse>
  )
}
