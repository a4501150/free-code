import * as React from 'react'
import type { Command } from '../commands.js'
import { Box } from '../ink.js'
import type { Screen } from '../types/repl.js'
import type { Tools } from '../Tool.js'
import type { RenderableMessage } from '../types/message.js'
import {
  getDisplayMessageFromCollapsed,
  getSearchOrReadInfo,
  getToolUseIdsFromCollapsedGroup,
  hasAnyToolInProgress,
} from '../utils/collapseReadSearch.js'
import {
  type buildMessageLookups,
  EMPTY_STRING_SET,
  getProgressMessagesFromLookup,
  getSiblingToolUseIDsFromLookup,
  getToolUseID,
} from '../utils/messages.js'
import { Message } from './Message.js'
import { MessageModel } from './MessageModel.js'
import { shouldRenderStatically } from './Messages.js'
import { MessageTimestamp } from './MessageTimestamp.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'

export type Props = {
  message: RenderableMessage
  /** Whether the previous message in renderableMessages is also a user message. */
  isUserContinuation: boolean
  /** Whether this row and the one before it are both injected-context rows. */
  isInjectedContextContinuation: boolean
  tools: Tools
  commands: Command[]
  verbose: boolean
  inProgressToolUseIDs: Set<string>
  streamingToolUseIDs: Set<string>
  screen: Screen
  canAnimate: boolean
  onOpenRateLimitOptions?: () => void
  latestBashOutputUUID: string | null
  columns: number
  isLoading: boolean
  lookups: ReturnType<typeof buildMessageLookups>
  showInjectedContext: boolean
}

function MessageRowImpl({
  message: msg,
  isUserContinuation,
  isInjectedContextContinuation,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  streamingToolUseIDs,
  screen,
  canAnimate,
  onOpenRateLimitOptions,
  latestBashOutputUUID,
  columns,
  isLoading,
  lookups,
  showInjectedContext,
}: Props): React.ReactNode {
  const isTranscriptMode = screen === 'transcript'
  const isGrouped = msg.type === 'grouped_tool_use'
  const isCollapsed = msg.type === 'collapsed_read_search'

  const hasUnresolvedCollapsedGroupTool =
    isCollapsed &&
    isLoading &&
    getToolUseIdsFromCollapsedGroup(msg).some(
      id => !lookups.resolvedToolUseIDs.has(id),
    )

  // Active only while a tool call inside this group itself is unresolved.
  // The surrounding turn's loading state must not keep a finished group in
  // the present-tense "still running" render (that made a completed search
  // wait on unrelated siblings to settle before flipping to past tense).
  const isActiveCollapsedGroup =
    isCollapsed &&
    (hasAnyToolInProgress(msg, inProgressToolUseIDs) ||
      hasUnresolvedCollapsedGroupTool)

  const displayMsg = isGrouped
    ? msg.displayMessage
    : isCollapsed
      ? getDisplayMessageFromCollapsed(msg)
      : msg

  const progressMessagesForMessage =
    isGrouped || isCollapsed ? [] : getProgressMessagesFromLookup(msg, lookups)

  const siblingToolUseIDs =
    isGrouped || isCollapsed
      ? EMPTY_STRING_SET
      : getSiblingToolUseIDsFromLookup(msg, lookups)

  const isStatic = shouldRenderStatically(
    msg,
    streamingToolUseIDs,
    inProgressToolUseIDs,
    siblingToolUseIDs,
    screen,
    lookups,
  )

  let shouldAnimate = false
  if (canAnimate) {
    // A tool counts as active both while it executes and while its input JSON
    // is still streaming: streaming ids enter inProgressToolUseIDs only when
    // execution starts, so without the streaming set the dot would sit static
    // grey through the whole parameter stream.
    const active = (id: string) =>
      inProgressToolUseIDs.has(id) || streamingToolUseIDs.has(id)
    if (isGrouped) {
      shouldAnimate = msg.messages.some(m => {
        const content = m.message.content[0]
        return content?.type === 'tool_use' && active(content.id)
      })
    } else if (isCollapsed) {
      shouldAnimate = hasAnyToolInProgress(
        msg,
        inProgressToolUseIDs,
        streamingToolUseIDs,
      )
    } else {
      const toolUseID = getToolUseID(msg)
      shouldAnimate = !toolUseID || active(toolUseID)
    }
  }

  const hasMetadata =
    isTranscriptMode &&
    displayMsg.type === 'assistant' &&
    displayMsg.message.content.some(c => c.type === 'text') &&
    (displayMsg.timestamp || displayMsg.message.model)

  const messageEl = (
    <Message
      message={msg}
      lookups={lookups}
      addMargin={!hasMetadata && !isInjectedContextContinuation}
      tools={tools}
      commands={commands}
      verbose={verbose}
      inProgressToolUseIDs={inProgressToolUseIDs}
      streamingToolUseIDs={streamingToolUseIDs}
      progressMessagesForMessage={progressMessagesForMessage}
      shouldAnimate={shouldAnimate}
      shouldShowDot={true}
      isTranscriptMode={isTranscriptMode}
      isStatic={isStatic}
      onOpenRateLimitOptions={onOpenRateLimitOptions}
      isActiveCollapsedGroup={isActiveCollapsedGroup}
      isUserContinuation={isUserContinuation}
      latestBashOutputUUID={latestBashOutputUUID}
      showInjectedContext={showInjectedContext}
    />
  )
  // OffscreenFreeze: the outer React.memo already bails for static messages,
  // so this only wraps rows that DO re-render — in-progress tools, collapsed
  // read/search spinners, bash elapsed timers. When those rows have scrolled
  // into terminal scrollback (non-fullscreen external builds), any content
  // change forces log-update.ts into a full terminal reset per tick. Freezing
  // returns the cached element ref so React bails and produces zero diff.
  if (!hasMetadata) {
    return (
      <OffscreenFreeze>
        <Box flexDirection="column" width={columns}>
          {messageEl}
        </Box>
      </OffscreenFreeze>
    )
  }
  // Margin on children, not here — else null items (hook_success etc.) get phantom 1-row spacing.
  return (
    <OffscreenFreeze>
      <Box width={columns} flexDirection="column">
        <Box
          flexDirection="row"
          justifyContent="flex-end"
          gap={1}
          marginTop={1}
        >
          <MessageTimestamp
            message={displayMsg}
            isTranscriptMode={isTranscriptMode}
          />
          <MessageModel
            message={displayMsg}
            isTranscriptMode={isTranscriptMode}
          />
        </Box>
        {messageEl}
      </Box>
    </OffscreenFreeze>
  )
}

/**
 * Checks if a message is "streaming" - i.e., its content may still be changing.
 * Exported for testing.
 */
export function isMessageStreaming(
  msg: RenderableMessage,
  streamingToolUseIDs: Set<string>,
): boolean {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.some(m => {
      const content = m.message.content[0]
      return content?.type === 'tool_use' && streamingToolUseIDs.has(content.id)
    })
  }
  if (msg.type === 'collapsed_read_search') {
    const toolIds = getToolUseIdsFromCollapsedGroup(msg)
    return toolIds.some(id => streamingToolUseIDs.has(id))
  }
  const toolUseID = getToolUseID(msg)
  return !!toolUseID && streamingToolUseIDs.has(toolUseID)
}

/**
 * Checks if all tools in a message are resolved.
 * Exported for testing.
 */
export function allToolsResolved(
  msg: RenderableMessage,
  resolvedToolUseIDs: Set<string>,
): boolean {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.every(m => {
      const content = m.message.content[0]
      return content?.type === 'tool_use' && resolvedToolUseIDs.has(content.id)
    })
  }
  if (msg.type === 'collapsed_read_search') {
    const toolIds = getToolUseIdsFromCollapsedGroup(msg)
    return toolIds.every(id => resolvedToolUseIDs.has(id))
  }
  if (msg.type === 'assistant') {
    const block = msg.message.content[0]
    if (block?.type === 'server_tool_use') {
      return resolvedToolUseIDs.has(block.id)
    }
  }
  const toolUseID = getToolUseID(msg)
  return !toolUseID || resolvedToolUseIDs.has(toolUseID)
}

/**
 * Conservative memo comparator that only bails out when we're CERTAIN
 * the message won't change. Fails safe by re-rendering when uncertain.
 *
 * Exported for testing.
 */
export function areMessageRowPropsEqual(prev: Props, next: Props): boolean {
  // Different message reference = content may have changed, must re-render
  if (prev.message !== next.message) return false

  // Screen mode change = re-render
  if (prev.screen !== next.screen) return false

  // Verbose toggle changes thinking block visibility
  if (prev.verbose !== next.verbose) return false

  // Toggling injected context adds/removes reminder rows
  if (prev.showInjectedContext !== next.showInjectedContext) return false

  // collapsed_read_search is never static in prompt mode (matches shouldRenderStatically)
  if (
    prev.message.type === 'collapsed_read_search' &&
    next.screen !== 'transcript'
  ) {
    return false
  }

  // Width change affects Box layout
  if (prev.columns !== next.columns) return false

  if (
    prev.isInjectedContextContinuation !== next.isInjectedContextContinuation
  ) {
    return false
  }

  // latestBashOutputUUID affects rendering (full vs truncated output)
  const prevIsLatestBash = prev.latestBashOutputUUID === prev.message.uuid
  const nextIsLatestBash = next.latestBashOutputUUID === next.message.uuid
  if (prevIsLatestBash !== nextIsLatestBash) return false

  // Check if this message is still "in flight"
  const isStreaming = isMessageStreaming(prev.message, prev.streamingToolUseIDs)
  const isResolved = allToolsResolved(
    prev.message,
    prev.lookups.resolvedToolUseIDs,
  )

  // Only bail out for truly static messages
  if (isStreaming || !isResolved) return false

  // Static message - safe to skip re-render
  return true
}

export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual)
