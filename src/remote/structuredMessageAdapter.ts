import type {
  DomainAssistantContent,
  DomainStreamEvent,
} from '../types/domain.js'
import type { UUID } from 'crypto'
import { createAnthropicStreamEventConverter } from '../types/domainConversion.js'
import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
} from 'src/structuredProtocol/index.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemMessage,
} from '../types/message.js'
import { fromSDKCompactMetadata } from '../utils/messages/mappers.js'

/**
 * Converts SDKMessage from CCR to REPL Message types.
 *
 * The CCR backend sends SDK-format messages via WebSocket. The REPL expects
 * internal Message types for rendering. This adapter bridges the two.
 */

/**
 * Convert an SDKAssistantMessage to an AssistantMessage
 */
function convertAssistantMessage(msg: SDKAssistantMessage): AssistantMessage {
  return {
    type: 'assistant',
    message: msg.message as unknown as DomainAssistantContent,
    uuid: msg.uuid as UUID,
    requestId: undefined,
    timestamp: new Date().toISOString(),
    error: msg.error,
  }
}

/**
 * Convert an SDKPartialAssistantMessage (streaming) to a StreamEvent
 */
const convertAnthropicStreamEvent = createAnthropicStreamEventConverter()

function convertStreamEvent(
  msg: SDKPartialAssistantMessage,
): StreamEvent | null {
  const event = convertAnthropicStreamEvent(
    msg.event as Parameters<typeof convertAnthropicStreamEvent>[0],
  )
  if (!event) return null
  return {
    type: 'stream_event',
    event: event as DomainStreamEvent,
  }
}

/**
 * Convert an SDKResultMessage to a SystemMessage
 */
function convertResultMessage(msg: SDKResultMessage): SystemMessage {
  const isError = msg.subtype !== 'success'
  const content = isError
    ? msg.errors?.join(', ') || 'Unknown error'
    : 'Session completed successfully'

  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: isError ? 'warning' : 'info',
    uuid: msg.uuid as UUID,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Convert an SDKSystemMessage (init) to a SystemMessage
 */
function convertInitMessage(msg: SDKSystemMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Remote session initialized (model: ${msg.model})`,
    level: 'info',
    uuid: msg.uuid as UUID,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Convert an SDKStatusMessage to a SystemMessage
 */
function convertStatusMessage(msg: SDKStatusMessage): SystemMessage | null {
  if (!msg.status) {
    return null
  }

  return {
    type: 'system',
    subtype: 'informational',
    content:
      msg.status === 'compacting'
        ? 'Compacting conversation…'
        : `Status: ${msg.status}`,
    level: 'info',
    uuid: msg.uuid as UUID,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Convert an SDKToolProgressMessage to a SystemMessage.
 * We use a system message instead of ProgressMessage since the Progress type
 * is a complex union that requires tool-specific data we don't have from CCR.
 */
function convertToolProgressMessage(
  msg: SDKToolProgressMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Tool ${msg.tool_name} running for ${msg.elapsed_time_seconds}s…`,
    level: 'info',
    uuid: msg.uuid as UUID,
    timestamp: new Date().toISOString(),
    toolUseID: msg.tool_use_id,
  }
}

/**
 * Convert an SDKCompactBoundaryMessage to a SystemMessage
 */
function convertCompactBoundaryMessage(
  msg: SDKCompactBoundaryMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    uuid: msg.uuid as UUID,
    timestamp: new Date().toISOString(),
    compactMetadata: fromSDKCompactMetadata(msg.compact_metadata),
  }
}

type ConvertOptions = {
  /** Convert user messages containing tool_result content blocks into UserMessages.
   * Used by direct connect mode where tool results come from the remote server
   * and need to be rendered locally. CCR mode ignores user messages since they
   * are handled differently. */
  convertToolResults?: boolean
  /**
   * Convert user text messages into UserMessages for display. Used when
   * converting historical events where user-typed messages need to be shown.
   * In live WS mode these are already added locally by the REPL so they're
   * ignored by default.
   */
  convertUserTextMessages?: boolean
}
