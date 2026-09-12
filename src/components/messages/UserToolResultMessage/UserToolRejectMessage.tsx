import * as React from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useTheme } from '../../../ink.js'
import {
  filterToolProgressMessages,
  type Tool,
  type Tools,
} from '../../../Tool.js'
import type { ProgressMessage } from '../../../types/message.js'
import type { buildMessageLookups } from '../../../utils/messages.js'
import { Box, Text } from '../../../ink.js'
import { FallbackToolUseRejectedMessage } from '../../FallbackToolUseRejectedMessage.js'
import { MessageResponse } from '../../MessageResponse.js'

type Props = {
  input: { [key: string]: unknown }
  /**
   * The user's rejection feedback — exactly what the model sees after the
   * reject prefix (see userRejectReasonFromContent). Shown below the
   * tool-specific reject UI so the user sees what went back to the model.
   */
  reason?: string
  progressMessagesForMessage: ProgressMessage[]
  style?: 'condensed'
  tool?: Tool
  tools: Tools
  lookups: ReturnType<typeof buildMessageLookups>
  verbose: boolean
  isTranscriptMode?: boolean
}

export function UserToolRejectMessage({
  input,
  reason,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [theme] = useTheme()

  const rejectUI = () => {
    if (!tool || !tool.renderToolUseRejectedMessage) {
      return <FallbackToolUseRejectedMessage />
    }
    const parsedInput = tool.inputSchema.safeParse(input)
    if (!parsedInput.success) {
      return <FallbackToolUseRejectedMessage />
    }
    return (
      tool.renderToolUseRejectedMessage(parsedInput.data, {
        columns,
        messages: [],
        tools,
        verbose,
        progressMessagesForMessage: filterToolProgressMessages(
          progressMessagesForMessage,
        ),
        style,
        theme,
        isTranscriptMode,
      }) ?? <FallbackToolUseRejectedMessage />
    )
  }

  if (!reason) {
    return rejectUI()
  }

  return (
    <Box flexDirection="column">
      {rejectUI()}
      <MessageResponse>
        <Text dimColor italic>
          User said: {reason}
        </Text>
      </MessageResponse>
    </Box>
  )
}
