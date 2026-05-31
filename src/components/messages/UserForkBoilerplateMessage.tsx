import type { DomainUserTextBlock } from '../../types/domain.js'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../MessageResponse.js'

type Props = {
  addMargin: boolean
  param: DomainUserTextBlock
}

export function UserForkBoilerplateMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <MessageResponse>
        <Text dimColor>{param.text}</Text>
      </MessageResponse>
    </Box>
  )
}
