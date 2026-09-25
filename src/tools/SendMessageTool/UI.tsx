import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type { Input, SendMessageToolOutput } from './SendMessageTool.js'

export function renderToolUseMessage(_input: Partial<Input>): React.ReactNode {
  return null
}

export function renderToolResultMessage(
  content: SendMessageToolOutput | string,
  _progressMessages: unknown,
  _args: { verbose: boolean },
): React.ReactNode {
  const result: SendMessageToolOutput =
    typeof content === 'string' ? jsonParse(content) : content

  return (
    <MessageResponse>
      <Text dimColor>{result.message}</Text>
    </MessageResponse>
  )
}
