/**
 * Wire items in, renderable transcript units out.
 *
 * The viewer renders the same components the classic REPL renders — the
 * gap is not the look, it's the input: the REPL feeds them internal
 * Message objects, while the wire flattens each message into one item per
 * content block. This bridge rebuilds Message-shaped inputs from those
 * items so `<Message>` can render them unchanged, and encodes the two
 * policy decisions the viewer makes over the flat stream: assistant blocks
 * that came from one provider response regroup into one message (so the
 * tool cards' sibling lookups work), and injected-context rows are flagged
 * so the transcript can render them the classic way — collapsed by default,
 * expanded under showInjectedContext.
 *
 * Pure: no JSX, no Ink — the unit test runs it like any reducer.
 */
import type { UUID } from 'crypto'
import type {
  DomainToolResultBlockParam,
  DomainToolUseBlock,
  DomainUserTextBlock,
} from '../../types/domain.js'
import type {
  AssistantMessage,
  Message,
  NormalizedMessage,
  ProgressMessage,
  UserMessage,
} from '../../types/message.js'
import {
  buildMessageLookups,
  normalizeMessages,
  type MessageLookups,
} from '../../utils/messages.js'
import type { WireItem, WireTranscriptSnapshot } from '../../session/wire.js'

/**
 * Attachment types that exist to show the model something the user did not
 * type. Like the classic REPL, the viewer shows these as collapsed
 * reminder rows and expands them under showInjectedContext (ctrl+O, the
 * transcript's own affordance). Kept aligned with TYPES_WITHOUT_SUMMARY_LINE
 * in components/messages/attachmentVisibility.ts — the same rows that
 * contribute no summary line of their own.
 */
export const INJECTED_CONTEXT_TYPES: ReadonlySet<string> = new Set([
  'user_context_snapshot',
  'user_context_delta',
  'mcp_tools_delta',
  'mcp_instructions_delta',
  'session_guidance',
  'git_instructions',
  'skill_listing',
  'agent_listing_delta',
  'invoked_skills',
  'assistant_mode',
  'token_usage',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'auto_mode',
  'auto_mode_exit',
  'date_change',
  'current_session_memory',
])

export function isInjectedContextItem(item: WireItem): boolean {
  return (
    item.kind === 'attachment' &&
    INJECTED_CONTEXT_TYPES.has(item.attachment?.type ?? '')
  )
}

export type TranscriptUnit =
  /** A synthetic internal message to hand to <Message>. */
  | {
      kind: 'message'
      message: UserMessage | AssistantMessage
      itemIds: string[]
    }
  /**
   * An attachment row. Injected-context rows render as the classic
   * collapsed `▸ System reminder · …` disclosure (Expanded under
   * showInjectedContext); everything else keeps the viewer-native row.
   */
  | { kind: 'attachment'; item: WireItem; injected: boolean }
  /** A system/compact-seam row the viewer renders natively. */
  | { kind: 'system'; item: WireItem }
  /** A live-progress row, hung under the tool it belongs to. */
  | { kind: 'progress'; item: WireItem; progress: ProgressMessage }

export type BridgedTranscript = {
  units: TranscriptUnit[]
  /**
   * Over every synthetic message, so tool cards can resolve their calls,
   * resolved/errored states and siblings exactly as in the REPL.
   */
  lookups: MessageLookups
  /** Normalized single-block rows, in stream order — what to render. */
  rows: NormalizedMessage[]
}

type AssistantDraft = {
  message: AssistantMessage
  itemIds: string[]
}

export function bridgeTranscript(
  snapshot: WireTranscriptSnapshot,
  showInjectedContext: boolean,
): BridgedTranscript {
  const units: TranscriptUnit[] = []
  const messages: (UserMessage | AssistantMessage)[] = []
  // Tool results arrive after their call; hold the block until the unit is
  // emitted so the row order matches the stream.
  let openAssistant: AssistantDraft | null = null

  const flushAssistant = (): void => {
    if (!openAssistant) return
    units.push({
      kind: 'message',
      message: openAssistant.message,
      itemIds: openAssistant.itemIds,
    })
    messages.push(openAssistant.message)
    openAssistant = null
  }

  const assistantFor = (item: WireItem): AssistantDraft => {
    // Sibling calls from one provider response share a messageId: they
    // regroup into one assistant message, which is what the tool cards'
    // sibling/in-progress lookups key on.
    if (
      openAssistant &&
      item.messageId &&
      openAssistant.message.message.id === item.messageId
    ) {
      return openAssistant
    }
    flushAssistant()
    const draft: AssistantDraft = {
      message: {
        type: 'assistant',
        uuid: item.id as string as UUID,
        timestamp: item.timestamp,
        agentId: item.agentId,
        message: {
          id: item.messageId ?? (item.id as string),
          type: 'message',
          role: 'assistant',
          content: [],
          model: item.model ?? '',
          stop_reason: null,
          stop_sequence: null,
          // The wire carries no usage per block; the renderer reads usage
          // only for rate-limit copy, which a viewer learns from meta.
          usage: {} as AssistantMessage['message']['usage'],
        },
      },
      itemIds: [],
    }
    openAssistant = draft
    return draft
  }

  const userMessage = (
    item: WireItem,
    content: DomainToolResultBlockParam | DomainUserTextBlock,
  ): UserMessage => ({
    type: 'user',
    uuid: item.id as string as UUID,
    timestamp: item.timestamp,
    isMeta: item.isMeta,
    isSidechain: item.isSidechain,
    message: { role: 'user', content: [content] },
  })

  for (const id of snapshot.order) {
    const item = snapshot.items.find(candidate => candidate.id === id)
    if (!item) continue

    switch (item.kind) {
      case 'user': {
        flushAssistant()
        if (!item.text && !item.image) continue
        const message = userMessage(item, {
          type: 'text',
          text: item.text ?? '',
        })
        units.push({ kind: 'message', message, itemIds: [item.id] })
        messages.push(message)
        continue
      }
      case 'assistant': {
        if (!item.text) continue
        const draft = assistantFor(item)
        draft.message.message.content.push({ type: 'text', text: item.text })
        draft.itemIds.push(item.id)
        continue
      }
      case 'reasoning': {
        if (!item.text) continue
        const draft = assistantFor(item)
        draft.message.message.content.push({
          type: 'reasoning',
          text: item.text,
        })
        // The dispatcher reads durationMs off the message, as in the REPL.
        if (item.durationMs !== undefined) {
          ;(draft.message as Record<string, unknown>).thinkingDurationMs =
            item.durationMs
        }
        draft.itemIds.push(item.id)
        continue
      }
      case 'tool_use': {
        const draft = assistantFor(item)
        const block: DomainToolUseBlock = {
          type: 'tool_use',
          id: item.toolUseId ?? item.id,
          name: item.toolName ?? 'tool',
          input: item.toolInput ?? {},
        }
        draft.message.message.content.push(block)
        draft.itemIds.push(item.id)
        continue
      }
      case 'tool_result': {
        flushAssistant()
        const block: DomainToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: item.toolUseId ?? '',
          content: item.text ?? '',
          is_error: item.isError,
        }
        const message = userMessage(item, block)
        units.push({ kind: 'message', message, itemIds: [item.id] })
        messages.push(message)
        continue
      }
      case 'progress': {
        flushAssistant()
        units.push({
          kind: 'progress',
          item,
          progress: {
            type: 'progress',
            uuid: item.id as string as UUID,
            timestamp: item.timestamp,
            toolUseID: item.progress?.toolUseId ?? '',
            data: (item.progress?.data ?? {}) as ProgressMessage['data'],
          },
        })
        continue
      }
      case 'system': {
        flushAssistant()
        if (item.isMeta) continue
        units.push({ kind: 'system', item })
        continue
      }
      case 'attachment': {
        flushAssistant()
        // Injected-context rows ride like every other row: the classic
        // pane shows them collapsed by default (`▸ System reminder · …`),
        // and the transcript component decides reveal vs collapse from
        // showInjectedContext. Dropping them here hid rows the classic
        // pane shows, which reads as a different product.
        units.push({
          kind: 'attachment',
          item,
          injected: isInjectedContextItem(item),
        })
        continue
      }
      default: {
        // Kinds this viewer does not place yet: ignore, as every wire
        // reader is required to.
        void (item satisfies WireItem)
      }
    }
  }
  flushAssistant()

  const rows = normalizeMessages(messages as (UserMessage | AssistantMessage)[])
  const lookups = buildMessageLookups(rows, messages)
  return { units, lookups, rows }
}
