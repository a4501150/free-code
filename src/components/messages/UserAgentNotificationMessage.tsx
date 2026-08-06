import type { DomainUserTextBlock } from '../../types/domain.js'
import * as React from 'react'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box, Text, type TextProps } from '../../ink.js'
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../constants/xml.js'
import { extractTag } from '../../utils/messages.js'
import { MessageResponse } from '../MessageResponse.js'

type Props = {
  addMargin: boolean
  param: DomainUserTextBlock
  verbose: boolean
  showInjectedContext: boolean
}

function getStatusColor(status: string | null): TextProps['color'] {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return 'text'
  }
}

export function UserAgentNotificationMessage({
  addMargin,
  param: { text },
  verbose,
  showInjectedContext,
}: Props): React.ReactNode {
  const summary = extractTag(text, SUMMARY_TAG)
  const status = extractTag(text, STATUS_TAG)
  const color = getStatusColor(status)

  // The notification's own fields (task id, output file, usage, result) are
  // the injected detail; the summary line stays the collapsed form so the
  // default appearance is unchanged.
  const body = showInjectedContext
    ? extractTag(text, TASK_NOTIFICATION_TAG)?.trim() || null
    : null

  if (!summary && !body) return null

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color={color}>{BLACK_CIRCLE}</Text>{' '}
        {summary ?? 'Task notification'}
      </Text>
      {body && verbose && (
        <MessageResponse>
          <Text dimColor wrap="wrap">
            {body}
          </Text>
        </MessageResponse>
      )}
    </Box>
  )
}
