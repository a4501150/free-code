import type { DomainToolResultBlockParam } from '../../../types/domain.js'
import * as React from 'react'
import { BULLET_OPERATOR } from '../../../constants/figures.js'
import { Text } from '../../../ink.js'
import {
  filterToolProgressMessages,
  type Tool,
  type Tools,
} from '../../../Tool.js'
import type { ProgressMessage } from '../../../types/message.js'
import {
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isClassifierDenial,
  PLAN_REJECTION_PREFIX,
  userRejectReasonFromContent,
} from '../../../utils/messages.js'
import { FallbackToolUseErrorMessage } from '../../FallbackToolUseErrorMessage.js'
import { InterruptedByUser } from '../../InterruptedByUser.js'
import { MessageResponse } from '../../MessageResponse.js'
import { RejectedPlanMessage } from './RejectedPlanMessage.js'
import { RejectedToolUseMessage } from './RejectedToolUseMessage.js'

type Props = {
  progressMessagesForMessage: ProgressMessage[]
  tool?: Tool // undefined when resuming an old conversation that uses an old tool
  tools: Tools
  param: DomainToolResultBlockParam
  /** Raw tool_use input; lets wrapper tools name the inner call on failure. */
  input?: unknown
  verbose: boolean
  isTranscriptMode?: boolean
}

export function UserToolErrorMessage({
  progressMessagesForMessage,
  tool,
  tools,
  param,
  input,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  if (
    typeof param.content === 'string' &&
    param.content.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)
  ) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    )
  }

  if (
    typeof param.content === 'string' &&
    param.content.startsWith(PLAN_REJECTION_PREFIX)
  ) {
    // Extract the plan content from the error message
    const planContent = param.content.substring(PLAN_REJECTION_PREFIX.length)
    return <RejectedPlanMessage plan={planContent} />
  }

  const rejectReason = userRejectReasonFromContent(param.content)
  if (rejectReason !== undefined) {
    // Reached via callers that pass tool_results straight here (collapsed
    // groups); the main path routes with-reason rejects through
    // UserToolRejectMessage instead.
    return <RejectedToolUseMessage reason={rejectReason} />
  }

  if (typeof param.content === 'string' && isClassifierDenial(param.content)) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>
          Denied by auto mode classifier {BULLET_OPERATOR} /feedback if
          incorrect
        </Text>
      </MessageResponse>
    )
  }

  const legacyContent = param.content as Parameters<
    NonNullable<Tool['renderToolUseErrorMessage']>
  >[0]

  const inner = tool?.unwrapInnerCall?.(input as never, tools)
  // Swap in the inner args only when the inner tool is the render target; a
  // wrapper fallback renderer must still see the raw tool_use input.
  const useInner = Boolean(inner?.tool.renderToolUseErrorMessage)
  const renderTarget = useInner ? inner!.tool : tool

  return (
    renderTarget?.renderToolUseErrorMessage?.(legacyContent, {
      progressMessagesForMessage: filterToolProgressMessages(
        progressMessagesForMessage,
      ),
      tools,
      verbose,
      isTranscriptMode,
      input: useInner ? inner!.input : input,
    }) ?? (
      <FallbackToolUseErrorMessage result={legacyContent} verbose={verbose} />
    )
  )
}
