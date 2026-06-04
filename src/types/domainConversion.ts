/**
 * Conversion functions between provider-neutral domain types and
 * Anthropic wire-format types. These are used at the boundaries:
 *
 * - Inbound:  Wire JSON → domain blocks (in adapters and streaming loop)
 * - Outbound: domain blocks → wire JSON (before API calls)
 * - Persistence: legacy transcripts → domain blocks (on load)
 *
 * No SDK dependency — uses minimal structural types that match the
 * Anthropic JSON wire shapes. The Anthropic adapter casts to SDK types
 * at its own call sites.
 */

// Minimal structural types matching Anthropic JSON wire shapes.
export type WireContentBlock = { type: string; [key: string]: unknown }
export type WireMessage = {
  id: string
  type: string
  role: string
  model: string
  content: WireContentBlock[]
  stop_reason: string | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    [key: string]: unknown
  }
}
export type WireStreamEvent = { type: string; [key: string]: unknown }

import type {
  DomainAssistantContent,
  DomainContentBlock,
  DomainContentDelta,
  DomainReasoningBlock,
  DomainRedactedReasoningBlock,
  DomainStopReason,
  DomainStreamEvent,
  DomainToolResultBlockParam,
  DomainUsage,
  DomainUserContentBlock,
  ProviderState,
} from './domain.js'

// ── Inbound: Anthropic SDK → Domain ────────────────────────────────

export function anthropicBlockToDomain(
  block: WireContentBlock,
): DomainContentBlock {
  switch (block.type) {
    case 'thinking':
      return {
        type: 'reasoning',
        text: block.thinking as string,
        providerState: {
          anthropic: {
            signature: block.signature as string,
            blockKind: 'thinking',
          },
        },
      }
    case 'redacted_thinking':
      return {
        type: 'redacted_reasoning',
        providerState: {
          anthropic: {
            redactedData: (block.data as string) ?? '',
            blockKind: 'redacted_thinking',
          },
        },
      }
    case 'text':
      return {
        type: 'text',
        text: block.text as string,
        ...(block.citations ? { citations: block.citations } : {}),
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      }
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      }
    default:
      // Passthrough for block types we don't explicitly model.
      // Preserve the full structure as-is.
      return block as unknown as DomainContentBlock
  }
}

export function anthropicMessageToDomain(
  msg: WireMessage,
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
        cache_creation_input_tokens: msg.usage
          .cache_creation_input_tokens as number,
      }),
      ...(msg.usage.cache_read_input_tokens != null && {
        cache_read_input_tokens: msg.usage.cache_read_input_tokens as number,
      }),
      ...(msg.usage.server_tool_use != null && {
        server_tool_use: msg.usage.server_tool_use,
      }),
    },
  }
}

// ── Outbound: Domain → Anthropic SDK ───────────────────────────────

export function domainBlockToAnthropic(
  block: DomainContentBlock,
): WireContentBlock | null {
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
      } as WireContentBlock
    }
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.citations ? { citations: block.citations } : {}),
      } as WireContentBlock
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      } as WireContentBlock
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      } as WireContentBlock
    case 'server_tool_result':
      return block as unknown as WireContentBlock
    default:
      return block as unknown as WireContentBlock
  }
}

export function domainUsageToAnthropic(
  usage: DomainUsage,
): WireMessage['usage'] {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    ...(usage.server_tool_use != null && {
      server_tool_use: usage.server_tool_use,
    }),
  }
}

export function domainMessageToAnthropic(
  msg: DomainAssistantContent,
): WireMessage {
  const content = msg.content
    .map(domainBlockToAnthropic)
    .filter((b): b is WireContentBlock => b !== null)

  return {
    id: msg.id,
    type: 'message',
    role: 'assistant',
    content,
    model: msg.model,
    stop_reason: msg.stop_reason,
    stop_sequence: msg.stop_sequence,
    usage: domainUsageToAnthropic(msg.usage),
  }
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
  block: WireContentBlock,
): DomainUserContentBlock {
  return block as unknown as DomainUserContentBlock
}

export function anthropicToolResultToDomain(
  block: WireContentBlock,
): DomainToolResultBlockParam {
  return block as unknown as DomainToolResultBlockParam
}

// ── User Content: Domain → Anthropic SDK ──────────────────────────

export function domainUserBlockToAnthropic(
  block: DomainUserContentBlock,
): WireContentBlock {
  return block as unknown as WireContentBlock
}

export function domainToolResultToAnthropic(
  block: DomainToolResultBlockParam,
): WireContentBlock {
  return block as unknown as WireContentBlock
}

// ── Stream Events: Anthropic SDK → Domain ─────────────────────────

type AnthropicStreamEventConverterState = {
  signaturesByIndex: Map<number, string>
  blockKindsByIndex: Map<number, 'thinking'>
}

function getStreamEventIndex(event: WireStreamEvent): number | undefined {
  if (typeof event.index === 'number') return event.index
  if (typeof event.index === 'string') {
    const index = Number(event.index)
    return Number.isFinite(index) ? index : undefined
  }
  return undefined
}

function isAnthropicSignatureDelta(event: WireStreamEvent): boolean {
  return (
    event.type === 'content_block_delta' &&
    (event.delta as { type?: unknown } | undefined)?.type === 'signature_delta'
  )
}

function providerStateWithAnthropicSignature(
  domainEvent: DomainStreamEvent,
  signature: string,
  blockKind: 'thinking' | undefined,
): DomainStreamEvent {
  if (domainEvent.type !== 'content_block_stop') return domainEvent
  const existingAnthropic = domainEvent.providerState?.anthropic
  const anthropicState =
    existingAnthropic && typeof existingAnthropic === 'object'
      ? (existingAnthropic as Record<string, unknown>)
      : {}
  return {
    ...domainEvent,
    providerState: {
      ...(domainEvent.providerState ?? {}),
      anthropic: {
        ...anthropicState,
        ...(blockKind && { blockKind }),
        signature,
      },
    },
  }
}

export function createAnthropicStreamEventConverter(): (
  event: WireStreamEvent,
) => DomainStreamEvent | null {
  const state: AnthropicStreamEventConverterState = {
    signaturesByIndex: new Map(),
    blockKindsByIndex: new Map(),
  }

  return (event: WireStreamEvent): DomainStreamEvent | null => {
    if (event.type === 'message_start') {
      state.signaturesByIndex.clear()
      state.blockKindsByIndex.clear()
    }

    const index = getStreamEventIndex(event)

    if (event.type === 'content_block_start' && index !== undefined) {
      state.signaturesByIndex.delete(index)
      const wireBlock = event.content_block as { type?: unknown } | undefined
      if (wireBlock?.type === 'thinking') {
        state.blockKindsByIndex.set(index, 'thinking')
      } else {
        state.blockKindsByIndex.delete(index)
      }
    }

    if (isAnthropicSignatureDelta(event)) {
      if (index !== undefined) {
        const delta = event.delta as { signature?: unknown }
        if (typeof delta.signature === 'string') {
          state.signaturesByIndex.set(
            index,
            `${state.signaturesByIndex.get(index) ?? ''}${delta.signature}`,
          )
        }
      }
      return null
    }

    let domainEvent = anthropicStreamEventToDomain(event)

    if (event.type === 'content_block_stop' && index !== undefined) {
      const signature = state.signaturesByIndex.get(index)
      if (signature !== undefined) {
        domainEvent = providerStateWithAnthropicSignature(
          domainEvent,
          signature,
          state.blockKindsByIndex.get(index),
        )
      }
      state.signaturesByIndex.delete(index)
      state.blockKindsByIndex.delete(index)
    }

    if (event.type === 'message_stop') {
      state.signaturesByIndex.clear()
      state.blockKindsByIndex.clear()
    }

    return domainEvent
  }
}

export function anthropicStreamEventToDomain(
  event: WireStreamEvent,
): DomainStreamEvent {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'message_start',
        message: anthropicMessageToDomain(event.message as WireMessage),
      }
    case 'content_block_start':
      return {
        type: 'content_block_start',
        index: event.index as number,
        content_block: anthropicBlockToDomain(
          event.content_block as WireContentBlock,
        ),
      }
    case 'content_block_delta': {
      const d = event.delta as Record<string, unknown>
      let delta: DomainContentDelta | { type: string; [key: string]: unknown }
      switch (d.type) {
        case 'text_delta':
          delta = { type: 'text_delta', text: d.text as string }
          break
        case 'input_json_delta':
          delta = {
            type: 'input_json_delta',
            partial_json: d.partial_json as string,
          }
          break
        case 'thinking_delta':
          delta = { type: 'thinking_delta', thinking: d.thinking as string }
          break
        case 'citations_delta':
          delta = {
            type: 'citations_delta',
            citations: (d as { citation?: unknown }).citation,
          }
          break
        default:
          delta = d as { type: string; [key: string]: unknown }
      }
      return {
        type: 'content_block_delta',
        index: event.index as number,
        delta,
      }
    }
    case 'content_block_stop':
      return {
        type: 'content_block_stop',
        index: event.index as number,
      }
    case 'message_delta':
      return {
        type: 'message_delta',
        delta: {
          stop_reason: (event.delta as Record<string, unknown>)?.stop_reason as
            | DomainStopReason
            | null
            | undefined,
          stop_sequence: (event.delta as Record<string, unknown>)
            ?.stop_sequence as string | null | undefined,
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
): WireStreamEvent {
  return event as unknown as WireStreamEvent
}
