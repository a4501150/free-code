/**
 * Conversion functions between provider-neutral domain types and
 * Anthropic SDK types. These are used at the boundaries:
 *
 * - Inbound:  SDK stream events → domain blocks (in claude.ts streaming loop)
 * - Outbound: domain blocks → Anthropic SDK params (before API calls)
 * - Persistence: legacy transcripts → domain blocks (on load)
 */

import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { APIError } from '@anthropic-ai/sdk'
import type {
  DomainApiError,
  DomainAssistantContent,
  DomainContentBlock,
  DomainContentDelta,
  DomainReasoningBlock,
  DomainRedactedReasoningBlock,
  DomainStopReason,
  DomainStreamEvent,
  DomainToolResultBlockParam,
  DomainToolResultContentItem,
  DomainUsage,
  DomainUserContentBlock,
  ProviderState,
} from './domain.js'

// ── Inbound: Anthropic SDK → Domain ────────────────────────────────

/**
 * Convert a BetaContentBlock from the Anthropic SDK into a domain block.
 * Handles thinking → reasoning mapping and strips ad-hoc provider fields.
 */
export function anthropicBlockToDomain(
  block: BetaContentBlock,
): DomainContentBlock {
  switch (block.type) {
    case 'thinking':
      return {
        type: 'reasoning',
        text: block.thinking,
        providerState: {
          anthropic: {
            signature: block.signature,
            blockKind: 'thinking',
          },
        },
      }
    case 'redacted_thinking':
      return {
        type: 'redacted_reasoning',
        providerState: {
          anthropic: {
            redactedData: (block as { data?: string }).data ?? '',
            blockKind: 'redacted_thinking',
          },
        },
      }
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.citations ? { citations: block.citations } : {}),
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    default:
      // Passthrough for block types we don't explicitly model.
      // Preserve the full structure as-is.
      return block as unknown as DomainContentBlock
  }
}

/**
 * Convert a full BetaMessage from the Anthropic SDK into a DomainAssistantContent.
 */
export function anthropicMessageToDomain(
  msg: BetaMessage,
): DomainAssistantContent {
  return {
    id: msg.id,
    type: 'message',
    role: 'assistant',
    content: msg.content.map(anthropicBlockToDomain),
    model: msg.model,
    stop_reason: msg.stop_reason as DomainStopReason | null,
    stop_sequence: msg.stop_sequence,
    usage: {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      ...(msg.usage.cache_creation_input_tokens != null && {
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
      }),
      ...(msg.usage.cache_read_input_tokens != null && {
        cache_read_input_tokens: msg.usage.cache_read_input_tokens,
      }),
      ...((msg.usage as { server_tool_use?: unknown }).server_tool_use !=
        null && {
        server_tool_use: (msg.usage as { server_tool_use?: unknown })
          .server_tool_use,
      }),
    },
  }
}

// ── Outbound: Domain → Anthropic SDK ───────────────────────────────

/**
 * Convert a domain content block to an Anthropic SDK content block for
 * outbound API requests. Returns null for blocks that should be stripped
 * (e.g. reasoning blocks without valid Anthropic signatures).
 */
export function domainBlockToAnthropic(
  block: DomainContentBlock,
): BetaContentBlock | null {
  switch (block.type) {
    case 'reasoning': {
      const sig = block.providerState?.anthropic?.signature
      if (!sig) return null
      return {
        type: 'thinking',
        thinking: block.text,
        signature: sig,
      }
    }
    case 'redacted_reasoning': {
      const data = block.providerState?.anthropic?.redactedData
      if (!data) return null
      return {
        type: 'redacted_thinking',
        data,
      } as BetaContentBlock
    }
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.citations ? { citations: block.citations } : {}),
      } as BetaContentBlock
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      } as BetaContentBlock
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      } as BetaContentBlock
    case 'server_tool_result':
      return block as unknown as BetaContentBlock
    default:
      return block as unknown as BetaContentBlock
  }
}

/**
 * Convert domain usage to BetaUsage-compatible shape.
 */
export function domainUsageToAnthropic(
  usage: DomainUsage,
): BetaMessage['usage'] {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    ...(usage.server_tool_use != null && {
      server_tool_use: usage.server_tool_use,
    }),
  } as BetaMessage['usage']
}

/**
 * Convert a DomainAssistantContent to a BetaMessage for the Anthropic SDK.
 * Used when the SDK needs a BetaMessage shape (e.g. for streaming API calls).
 */
export function domainMessageToAnthropic(
  msg: DomainAssistantContent,
): BetaMessage {
  const content = msg.content
    .map(domainBlockToAnthropic)
    .filter((b): b is BetaContentBlock => b !== null)

  return {
    id: msg.id,
    type: 'message',
    role: 'assistant',
    content,
    model: msg.model,
    stop_reason: msg.stop_reason,
    stop_sequence: msg.stop_sequence,
    usage: domainUsageToAnthropic(msg.usage),
    container: null,
  } as BetaMessage
}

// ── Persistence: Legacy Transcript → Domain ────────────────────────

/**
 * Migrate a legacy (v1) content block from persisted transcripts into
 * a domain block. Handles:
 * - thinking → reasoning (with Anthropic providerState)
 * - thinking + codexReasoningId → reasoning (with OpenAI Responses providerState)
 * - redacted_thinking → redacted_reasoning
 * - all other blocks pass through unchanged
 */
export function legacyBlockToDomain(block: unknown): DomainContentBlock {
  if (!block || typeof block !== 'object') {
    return block as DomainContentBlock
  }

  const b = block as Record<string, unknown>

  if (b.type === 'thinking') {
    const text = typeof b.thinking === 'string' ? b.thinking : ''
    const providerState: ProviderState = {}

    if (typeof b.codexReasoningId === 'string' && b.codexReasoningId) {
      providerState.openaiResponses = {
        reasoningId: b.codexReasoningId,
        ...(typeof b.codexEncryptedContent === 'string' && {
          encryptedContent: b.codexEncryptedContent,
        }),
      }
    } else if (typeof b.signature === 'string' && b.signature) {
      providerState.anthropic = {
        signature: b.signature,
        blockKind: 'thinking',
      }
    }

    return {
      type: 'reasoning',
      text,
      ...(Object.keys(providerState).length > 0 && { providerState }),
    } satisfies DomainReasoningBlock
  }

  if (b.type === 'redacted_thinking') {
    const providerState: ProviderState = {}
    if (typeof b.data === 'string') {
      providerState.anthropic = {
        redactedData: b.data,
        blockKind: 'redacted_thinking',
      }
    }
    return {
      type: 'redacted_reasoning',
      ...(Object.keys(providerState).length > 0 && { providerState }),
    } satisfies DomainRedactedReasoningBlock
  }

  // Already a domain block (reasoning/redacted_reasoning) or a
  // non-reasoning block (text/tool_use/etc.) — pass through.
  return block as DomainContentBlock
}

/**
 * Migrate an entire message's content blocks from legacy format.
 * Only processes blocks that need migration (thinking/redacted_thinking);
 * other blocks pass through unchanged.
 */
export function migrateLegacyContent(content: unknown[]): DomainContentBlock[] {
  return content.map(legacyBlockToDomain)
}

/**
 * Check if content blocks need legacy migration.
 * Returns true if any block uses the old thinking/redacted_thinking types.
 */
export function needsLegacyMigration(content: unknown[]): boolean {
  return content.some(
    b =>
      b &&
      typeof b === 'object' &&
      ((b as { type?: string }).type === 'thinking' ||
        (b as { type?: string }).type === 'redacted_thinking'),
  )
}

// ── User Content: Anthropic SDK → Domain ──────────────────────────

export function anthropicUserBlockToDomain(
  block: ContentBlockParam,
): DomainUserContentBlock {
  // The SDK ContentBlockParam and domain user content have compatible shapes;
  // cast through unknown to avoid structural mismatches on cache_control/citations.
  return block as unknown as DomainUserContentBlock
}

export function anthropicToolResultToDomain(
  block: ToolResultBlockParam,
): DomainToolResultBlockParam {
  return block as unknown as DomainToolResultBlockParam
}

// ── User Content: Domain → Anthropic SDK ──────────────────────────

export function domainUserBlockToAnthropic(
  block: DomainUserContentBlock,
): ContentBlockParam {
  return block as unknown as ContentBlockParam
}

export function domainToolResultToAnthropic(
  block: DomainToolResultBlockParam,
): ToolResultBlockParam {
  return block as unknown as ToolResultBlockParam
}

// ── Stream Events: Anthropic SDK → Domain ─────────────────────────

export function anthropicStreamEventToDomain(
  event: BetaRawMessageStreamEvent,
): DomainStreamEvent {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'message_start',
        message: anthropicMessageToDomain(event.message),
      }
    case 'content_block_start':
      return {
        type: 'content_block_start',
        index: event.index,
        content_block: anthropicBlockToDomain(
          event.content_block as BetaContentBlock,
        ),
      }
    case 'content_block_delta': {
      const d = event.delta as unknown as Record<string, unknown>
      let delta: DomainContentDelta | { type: string; [key: string]: unknown }
      switch (d.type) {
        case 'text_delta':
          delta = { type: 'text_delta', text: d.text as string }
          break
        case 'input_json_delta':
          delta = { type: 'input_json_delta', partial_json: d.partial_json as string }
          break
        case 'thinking_delta':
          delta = { type: 'thinking_delta', thinking: d.thinking as string }
          break
        case 'signature_delta':
          delta = { type: 'signature_delta', signature: d.signature as string }
          break
        case 'citations_delta':
          delta = { type: 'citations_delta', citations: (d as { citation?: unknown }).citation }
          break
        default:
          delta = d as { type: string; [key: string]: unknown }
      }
      return {
        type: 'content_block_delta',
        index: event.index,
        delta,
      }
    }
    case 'content_block_stop':
      return {
        type: 'content_block_stop',
        index: event.index,
      }
    case 'message_delta':
      return {
        type: 'message_delta',
        delta: {
          stop_reason: (event.delta as unknown as { stop_reason?: string }).stop_reason as DomainStopReason | null | undefined,
          stop_sequence: (event.delta as unknown as { stop_sequence?: string | null }).stop_sequence,
        },
        usage: event.usage as DomainUsage | undefined,
      }
    case 'message_stop':
      return { type: 'message_stop' }
    default:
      return event as unknown as DomainStreamEvent
  }
}

// ── Stream Events: Domain → Anthropic SDK ─────────────────────────

export function domainStreamEventToAnthropic(
  event: DomainStreamEvent,
): BetaRawMessageStreamEvent {
  return event as unknown as BetaRawMessageStreamEvent
}

// ── API Error: Anthropic SDK → Domain ─────────────────────────────

export function apiErrorToDomain(error: APIError): DomainApiError {
  return {
    status: error.status,
    message: error.message,
    ...(error.requestID && { requestID: error.requestID }),
    headers: error.headers
      ? Object.fromEntries(error.headers.entries())
      : undefined,
    raw: error,
  }
}
