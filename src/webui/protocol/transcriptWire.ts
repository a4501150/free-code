/**
 * The browser-facing transcript model.
 *
 * Internal `Message` objects carry live tools, process-local metadata and
 * binary content, so they are never sent as-is. Each message is flattened into
 * one item per content block, which is what the terminal renders anyway, and
 * every item carries a content hash so a client can apply a patch idempotently.
 */

import type { Message } from '../../types/message.js'
import type {
  DomainContentBlock,
  DomainUserContentBlock,
} from '../../types/domain.js'

export type WebTranscriptItemKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_use'
  | 'tool_result'
  | 'attachment'
  | 'system'

export type WebTranscriptItem = {
  id: string
  kind: WebTranscriptItemKind
  /** Content fingerprint. A client replaces an item when this changes. */
  rev: string
  timestamp: string
  text?: string
  /** True for messages the terminal shows dimmed or hides from the model. */
  isMeta?: boolean
  isSidechain?: boolean
  agentId?: string
  /**
   * Set on a user image block. Metadata only: the bytes stay in the session
   * and travel over `get_image` when the reader asks for them.
   */
  image?: { mediaType: string; bytes: number }
  /** assistant */
  model?: string
  /** tool_use */
  toolName?: string
  toolUseId?: string
  toolInput?: unknown
  /** tool_result */
  isError?: boolean
  /** system */
  subtype?: string
  level?: string
}

export type WebTranscriptSnapshot = {
  items: WebTranscriptItem[]
  order: string[]
}

export type TranscriptPatch =
  | {
      type: 'delta'
      upsert: WebTranscriptItem[]
      remove: string[]
      /** Present when the new order is the old order plus a suffix. */
      orderAppend?: string[]
      /** Present when the order changed in a way an append cannot express. */
      order?: string[]
    }
  | { type: 'replace'; snapshot: WebTranscriptSnapshot }

const MAX_TEXT_BYTES = 64 * 1024

/**
 * FNV-1a. Not cryptographic: this only has to change when content changes, and
 * it runs on every streaming delta, so speed matters more than collision
 * resistance.
 */
function fingerprint(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function clip(text: string): string {
  return text.length > MAX_TEXT_BYTES
    ? `${text.slice(0, MAX_TEXT_BYTES)}\n… truncated`
    : text
}

function finish(item: Omit<WebTranscriptItem, 'rev'>): WebTranscriptItem {
  // Hash everything except the id, so a resumed message with the same content
  // does not look changed.
  const { id: _id, ...rest } = item
  return { ...item, rev: fingerprint(JSON.stringify(rest)) }
}

function userBlockItems(
  message: Message & { type: 'user' },
): WebTranscriptItem[] {
  const content = message.message.content
  const base = {
    timestamp: message.timestamp,
    isMeta: message.isMeta === true ? true : undefined,
    isSidechain: message.isSidechain,
    agentId: message.agentId,
  }

  if (typeof content === 'string') {
    return [
      finish({
        ...base,
        id: `${message.uuid}:0`,
        kind: 'user',
        text: clip(content),
      }),
    ]
  }

  const items: WebTranscriptItem[] = []
  let imageOrdinal = 0
  content.forEach((block: DomainUserContentBlock, index) => {
    const id = `${message.uuid}:${index}`
    switch (block.type) {
      case 'text':
        items.push(
          finish({ ...base, id, kind: 'user', text: clip(block.text) }),
        )
        break
      case 'tool_result': {
        const raw = block.content
        const text =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? raw
                  .map(part =>
                    part.type === 'text' ? part.text : `[${part.type}]`,
                  )
                  .join('\n')
              : ''
        items.push(
          finish({
            ...base,
            id,
            kind: 'tool_result',
            text: clip(text),
            toolUseId: block.tool_use_id,
            isError: block.is_error === true ? true : undefined,
          }),
        )
        break
      }
      case 'image': {
        imageOrdinal += 1
        const source = block.source
        const base64 = source.type === 'base64' ? source.data : ''
        const mediaType = source.type === 'base64' ? source.media_type : ''
        items.push({
          ...base,
          id,
          kind: 'user',
          text: `[image ${imageOrdinal}]`,
          ...(base64 ? { image: { mediaType, bytes: base64.length } } : {}),
          // Not `finish()`, which hashes every character of the item. This runs
          // on every publish, and an image block never changes in place, so its
          // media type and size already identify it.
          rev: fingerprint(`image:${mediaType}:${base64.length}`),
        })
        break
      }
      default:
        items.push(
          finish({ ...base, id, kind: 'user', text: `[${block.type}]` }),
        )
    }
  })
  return items
}

function assistantBlockItems(
  message: Message & { type: 'assistant' },
): WebTranscriptItem[] {
  const base = {
    timestamp: message.timestamp,
    isMeta: message.isMeta === true ? true : undefined,
    isSidechain: message.isSidechain,
    agentId: message.agentId,
    model: message.message.model,
  }

  const items: WebTranscriptItem[] = []
  message.message.content.forEach((block: DomainContentBlock, index) => {
    const id = `${message.uuid}:${index}`
    switch (block.type) {
      case 'text':
        items.push(
          finish({ ...base, id, kind: 'assistant', text: clip(block.text) }),
        )
        break
      case 'reasoning':
        items.push(
          finish({ ...base, id, kind: 'reasoning', text: clip(block.text) }),
        )
        break
      case 'redacted_reasoning':
        items.push(
          finish({ ...base, id, kind: 'reasoning', text: '[redacted]' }),
        )
        break
      case 'tool_use':
      case 'server_tool_use':
        items.push(
          finish({
            ...base,
            id,
            kind: 'tool_use',
            toolName: block.name,
            toolUseId: block.id,
            toolInput: block.input,
          }),
        )
        break
      default:
        items.push(
          finish({ ...base, id, kind: 'assistant', text: `[${block.type}]` }),
        )
    }
  })
  return items
}

/**
 * Flattens the transcript. Progress messages are deliberately dropped: they are
 * ephemeral, replaced in place many times per second, and the browser shows
 * activity from session state instead.
 */
export function toWireSnapshot(
  messages: readonly Message[],
): WebTranscriptSnapshot {
  const items: WebTranscriptItem[] = []

  for (const message of messages) {
    switch (message.type) {
      case 'user':
        items.push(...userBlockItems(message))
        break
      case 'assistant':
        items.push(...assistantBlockItems(message))
        break
      case 'attachment':
        items.push(
          finish({
            id: `${message.uuid}:0`,
            kind: 'attachment',
            timestamp: message.timestamp,
            isMeta: true,
            text: message.attachment.type,
          }),
        )
        break
      case 'system':
        items.push(
          finish({
            id: `${message.uuid}:0`,
            kind: 'system',
            timestamp: message.timestamp,
            text: clip(message.content ?? ''),
            subtype: (message as { subtype?: string }).subtype,
            level: message.level,
            isMeta: message.isMeta,
          }),
        )
        break
      default:
        break
    }
  }

  return { items, order: items.map(item => item.id) }
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== full[i]) return false
  }
  return true
}

/**
 * Diffs two snapshots. The append case is expressed as `orderAppend`, because
 * resending the whole order on every streaming delta is the difference between
 * a few hundred bytes and tens of kilobytes on a long transcript.
 */
export function diffSnapshots(
  previous: WebTranscriptSnapshot,
  next: WebTranscriptSnapshot,
): TranscriptPatch | null {
  const previousById = new Map(previous.items.map(item => [item.id, item]))
  const nextById = new Map(next.items.map(item => [item.id, item]))

  const upsert = next.items.filter(item => {
    const before = previousById.get(item.id)
    return !before || before.rev !== item.rev
  })
  const remove = previous.order.filter(id => !nextById.has(id))

  const appended = isPrefix(previous.order, next.order)
  const orderChanged = !appended || next.order.length !== previous.order.length

  if (!upsert.length && !remove.length && !orderChanged) return null

  return {
    type: 'delta',
    upsert,
    remove,
    ...(appended
      ? next.order.length > previous.order.length
        ? { orderAppend: next.order.slice(previous.order.length) }
        : {}
      : { order: next.order }),
  }
}
