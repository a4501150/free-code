import type {
  DomainToolResultBlockParam,
  DomainToolUseBlock,
} from '../../types/domain.js'
import * as React from 'react'
import {
  filterToolProgressMessages,
  findToolByName,
  type Tools,
} from '../../Tool.js'
import type { GroupedToolUseMessage } from '../../types/message.js'
import type { buildMessageLookups } from '../../utils/messages.js'

type Props = {
  message: GroupedToolUseMessage
  tools: Tools
  lookups: ReturnType<typeof buildMessageLookups>
  inProgressToolUseIDs: Set<string>
  /** Tool uses whose input JSON is still streaming — blink their dot too. */
  streamingToolUseIDs?: Set<string>
  shouldAnimate: boolean
}

export function GroupedToolUseContent({
  message,
  tools,
  lookups,
  inProgressToolUseIDs,
  streamingToolUseIDs,
  shouldAnimate,
}: Props): React.ReactNode {
  const tool = findToolByName(tools, message.toolName)
  if (!tool?.renderGroupedToolUse) {
    return null
  }

  // Build a map from tool_use_id to result data
  const resultsByToolUseId = new Map<
    string,
    { param: DomainToolResultBlockParam; output: unknown }
  >()
  for (const resultMsg of message.results) {
    for (const content of resultMsg.message.content) {
      if (content.type === 'tool_result') {
        resultsByToolUseId.set(content.tool_use_id, {
          param: content,
          output: resultMsg.toolUseResult,
        })
      }
    }
  }

  const toolUsesData = message.messages.map(msg => {
    const content = msg.message.content[0] as {
      id: string
      type: string
      name?: string
      input?: unknown
    }
    const result = resultsByToolUseId.get(content.id)
    return {
      param: content as DomainToolUseBlock,
      isResolved: lookups.resolvedToolUseIDs.has(content.id),
      isError: lookups.erroredToolUseIDs.has(content.id),
      isInProgress: inProgressToolUseIDs.has(content.id),
      progressMessages: filterToolProgressMessages(
        lookups.progressMessagesByToolUseID.get(content.id) ?? [],
      ),
      result,
    }
  })

  // Blink while any call is executing OR while any call's input JSON is
  // still streaming (streaming ids join inProgressToolUseIDs only when
  // execution starts, so the streaming set must be checked too).
  const anyActive = toolUsesData.some(
    d =>
      inProgressToolUseIDs.has((d.param as { id: string }).id) ||
      (streamingToolUseIDs?.has((d.param as { id: string }).id) ?? false),
  )

  return tool.renderGroupedToolUse(
    toolUsesData as Parameters<
      NonNullable<typeof tool.renderGroupedToolUse>
    >[0],
    {
      shouldAnimate: shouldAnimate && anyActive,
      tools,
    },
  )
}
