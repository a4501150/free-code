/**
 * A live transcript comes wholly through its socket. Never splice a disk
 * snapshot to a socket tail — queued writes, mutable assistant messages, DAG
 * branches and UI reordering make the merge lossy.
 *
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
import { extractTag, isTaskNotificationText } from '../../utils/messages.js'
import {
  MONITOR_OUTPUT_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  SYSTEM_REMINDER_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'

export type WebTranscriptItemKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_use'
  | 'tool_result'
  | 'attachment'
  | 'system'
  | 'notification'

/** The structured body of a `<task-notification>` block, parsed server-side. */
export type WebTaskNotification = {
  /** Absent only when the block was classified but too broken to parse. */
  taskId?: string
  toolUseId?: string
  /** Distinguishes notice kinds sharing the wrapper (e.g. 'monitor'). */
  taskType?: string
  /** Absent on progress pings; present on terminal notices. */
  status?: 'completed' | 'failed' | 'killed'
  summary: string
  /** The agent's final message, when the notice carried one. */
  result?: string
  usage?: {
    totalTokens?: number
    toolUses?: number
    durationMs?: number
  }
  /** Monitor notices only: the trailing output the notice quoted. */
  outputTail?: string
  /**
   * The original text, kept only when parsing yielded nothing meaningful, so
   * a malformed notice still shows something instead of vanishing.
   */
  raw?: string
}

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
  /**
   * Set on a tool_result whose content array carries image parts. Metadata
   * only, like `image`, but a list: each entry's `id` addresses one part
   * within the block, `${message.uuid}:${blockIndex}:${partIndex}`.
   */
  images?: Array<{ id: string; mediaType: string; bytes: number }>
  /** assistant */
  model?: string
  /** Provider message ID, shared by sibling tool calls from one response. */
  messageId?: string
  /** tool_use */
  toolName?: string
  toolUseId?: string
  toolInput?: unknown
  /** tool_result */
  isError?: boolean
  /** system */
  subtype?: string
  /** system */
  level?: string
  /** notification — the parsed <task-notification> block */
  notification?: WebTaskNotification
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

/**
 * Strips synthetic XML-like tags from user message text.
 *
 * The TUI has dedicated renderers for these tags. The browser receives plain
 * text, so strip or unwrap them at the server boundary.
 */
function stripSyntheticTags(text: string): string {
  // Tags whose content should be removed entirely
  const stripTags = [
    'command-name',
    'command-message',
    'command-args',
    'local-command-caveat',
    'bash-input',
    'system-reminder',
    'skill-format',
  ]
  // Tags whose content should be kept (unwrap)
  const unwrapTags = [
    'local-command-stdout',
    'local-command-stderr',
    'bash-stdout',
    'bash-stderr',
  ]

  let result = text
  for (const tag of stripTags) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
  }
  for (const tag of unwrapTags) {
    result = result.replace(
      new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'),
      '$1',
    )
  }
  return result.trim()
}

/**
 * Parses a `<task-notification>` block into card fields, server-side, so no
 * browser parses XML. Tolerates both storage shapes: the raw block as written
 * by `renderTaskNotificationBlock` (idle drain), and the same block behind
 * the system-reminder wrapper and prose prefix a mid-turn drain gets from
 * `wrapCommandText` / `wrapMessagesInSystemReminder`. Trailing guidance
 * prose after the closing tag is dropped — it is written for the model.
 */
export function parseTaskNotification(
  text: string,
): WebTaskNotification | null {
  // Cheap gate first: this runs for every user item on every publish.
  if (!text.includes(`<${TASK_NOTIFICATION_TAG}`)) return null
  let body = text.trim()
  const reminder = extractTag(body, SYSTEM_REMINDER_TAG)
  if (reminder) body = reminder.trim()
  body = body.replace(/^A background agent completed a task:\n?/, '').trim()
  if (!isTaskNotificationText(body)) return null
  const block = extractTag(body, TASK_NOTIFICATION_TAG)
  if (!block) return null

  const taskId = extractTag(block, TASK_ID_TAG)?.trim()
  const summary = extractTag(block, SUMMARY_TAG)?.trim() ?? ''
  const rawStatus = extractTag(block, STATUS_TAG)?.trim()
  const status =
    rawStatus === 'completed' ||
    rawStatus === 'failed' ||
    rawStatus === 'killed'
      ? rawStatus
      : undefined
  const notification: WebTaskNotification = {
    summary,
    ...(taskId ? { taskId } : {}),
    ...(extractTag(block, TOOL_USE_ID_TAG)?.trim()
      ? { toolUseId: extractTag(block, TOOL_USE_ID_TAG)!.trim() }
      : {}),
    ...(extractTag(block, TASK_TYPE_TAG)?.trim()
      ? { taskType: extractTag(block, TASK_TYPE_TAG)!.trim() }
      : {}),
    ...(status ? { status } : {}),
  }
  if (!taskId && !summary) {
    // A recognized wrapper with nothing readable inside. Keep the original
    // text so the card shows something instead of an empty shell.
    notification.raw = text.trim()
    return notification
  }
  const result = extractTag(block, 'result')?.trim()
  if (result) notification.result = clip(result)
  const usageBlock = extractTag(block, 'usage')
  if (usageBlock) {
    const usage: NonNullable<WebTaskNotification['usage']> = {}
    const tokens = Number(extractTag(usageBlock, 'total_tokens')?.trim())
    const toolUses = Number(extractTag(usageBlock, 'tool_uses')?.trim())
    const durationMs = Number(extractTag(usageBlock, 'duration_ms')?.trim())
    if (Number.isFinite(tokens)) usage.totalTokens = tokens
    if (Number.isFinite(toolUses)) usage.toolUses = toolUses
    if (Number.isFinite(durationMs)) usage.durationMs = durationMs
    if (Object.keys(usage).length) notification.usage = usage
  }
  const outputTail = extractTag(block, MONITOR_OUTPUT_TAG)?.trim()
  if (outputTail) notification.outputTail = clip(outputTail)
  return notification
}

/** The one-line reason a user item becomes a notification item, if any. */
function userNotificationText(
  message: Message & { type: 'user' },
): string | undefined {
  const content = message.message.content
  const text =
    typeof content === 'string'
      ? content
      : content.length === 1 && content[0]?.type === 'text'
        ? content[0].text
        : undefined
  if (text !== undefined && parseTaskNotification(text)) return text
  // Notices stamped with an origin but no longer shaped like the block (an
  // older or damaged record) still deserve the card, with the raw text inside.
  if (message.origin?.kind === 'task-notification' && text !== undefined)
    return text
  return undefined
}

function userBlockItems(
  message: Message & { type: 'user' },
): WebTranscriptItem[] {
  // Compact summaries are internal continuation context, not user-facing.
  if ((message as { isCompactSummary?: boolean }).isCompactSummary) {
    return [
      finish({
        id: `${message.uuid}:0`,
        kind: 'user',
        timestamp: message.timestamp,
        isMeta: true,
        text: 'Conversation compacted',
      }),
    ]
  }

  const content = message.message.content
  const base = {
    timestamp: message.timestamp,
    isMeta:
      message.isMeta === true ||
      (message as { isVisibleInTranscriptOnly?: boolean })
        .isVisibleInTranscriptOnly === true
        ? true
        : undefined,
    isSidechain: message.isSidechain,
    agentId: message.agentId,
  }

  // A background-task notice renders as a card, not a user bubble, so the
  // raw XML never reaches the browser.
  const notificationText = userNotificationText(message)
  if (notificationText !== undefined) {
    const parsed =
      parseTaskNotification(notificationText) ??
      ({ summary: '', raw: notificationText.trim() } as WebTaskNotification)
    return [
      finish({
        ...base,
        id: `${message.uuid}:0`,
        kind: 'notification',
        notification: parsed,
      }),
    ]
  }

  if (typeof content === 'string') {
    const cleaned = stripSyntheticTags(content)
    if (!cleaned) return []
    return [
      finish({
        ...base,
        id: `${message.uuid}:0`,
        kind: 'user',
        text: clip(cleaned),
      }),
    ]
  }

  const items: WebTranscriptItem[] = []
  let imageOrdinal = 0
  content.forEach((block: DomainUserContentBlock, index) => {
    const id = `${message.uuid}:${index}`
    switch (block.type) {
      case 'text': {
        const cleaned = stripSyntheticTags(block.text)
        if (!cleaned) break
        items.push(finish({ ...base, id, kind: 'user', text: clip(cleaned) }))
        break
      }
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
        // Image parts stay out of the text like they do for user blocks: the
        // reader fetches the bytes by id when it opens one. The part index
        // rides on the id because a block can hold several images.
        const images: NonNullable<WebTranscriptItem['images']> = []
        if (Array.isArray(raw)) {
          raw.forEach((part, partIndex) => {
            if (part.type !== 'image') return
            const source = (part as { source?: Record<string, unknown> }).source
            if (source?.type !== 'base64') return
            images.push({
              id: `${id}:${partIndex}`,
              mediaType:
                typeof source.media_type === 'string' ? source.media_type : '',
              bytes: typeof source.data === 'string' ? source.data.length : 0,
            })
          })
        }
        items.push(
          finish({
            ...base,
            id,
            kind: 'tool_result',
            text: clip(text),
            toolUseId: block.tool_use_id,
            isError: block.is_error === true ? true : undefined,
            ...(images.length ? { images } : {}),
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
    messageId: message.message.id,
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
      case 'attachment': {
        // Queued commands carry the user's prompt text. Serialize it as a
        // user item so the browser shows what the user typed.
        const att = message.attachment
        if (att.type === 'queued_command') {
          const prompt = att.prompt
          const text =
            typeof prompt === 'string'
              ? prompt
              : Array.isArray(prompt)
                ? prompt
                    .filter(
                      (b): b is { type: 'text'; text: string } =>
                        b.type === 'text',
                    )
                    .map(b => b.text)
                    .join('\n')
                : ''
          if (text) {
            // A mid-turn task-notification drain: same card as the idle path,
            // keyed off the queue metadata rather than the text shape.
            const isNotice =
              att.origin?.kind === 'task-notification' ||
              att.commandMode === 'task-notification'
            const parsed = isNotice
              ? (parseTaskNotification(text) ?? {
                  summary: '',
                  raw: text.trim(),
                })
              : parseTaskNotification(text)
            if (parsed) {
              items.push(
                finish({
                  id: `${message.uuid}:0`,
                  kind: 'notification',
                  timestamp: message.timestamp,
                  isMeta: true,
                  notification: parsed,
                }),
              )
              break
            }
            items.push(
              finish({
                id: `${message.uuid}:0`,
                kind: 'user',
                timestamp: message.timestamp,
                isMeta: true,
                text: clip(text),
              }),
            )
          }
          break
        }
        items.push(
          finish({
            id: `${message.uuid}:0`,
            kind: 'attachment',
            timestamp: message.timestamp,
            isMeta: true,
            text: att.type,
          }),
        )
        break
      }
      case 'system': {
        // Hide compact boundaries, same as TUI behavior.
        const subtype = (message as { subtype?: string }).subtype
        if (
          subtype === 'compact_boundary' ||
          subtype === 'microcompact_boundary'
        ) {
          break
        }
        // A local_command row carries its output wrapped in synthetic tags
        // the TUI unwraps in a dedicated renderer; the browser gets plain
        // text, so unwrap here. Commands with no output (e.g. /clear) drop
        // the row entirely rather than show a literal empty tag.
        const content =
          subtype === 'local_command'
            ? stripSyntheticTags(message.content ?? '')
            : (message.content ?? '')
        if (!content) break
        items.push(
          finish({
            id: `${message.uuid}:0`,
            kind: 'system',
            timestamp: message.timestamp,
            text: clip(content),
            subtype,
            level: message.level,
            isMeta: message.isMeta,
          }),
        )
        break
      }
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
