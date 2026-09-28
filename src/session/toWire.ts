/**
 * Internal transcript -> wire transcript serialization (v2).
 *
 * Successor of `webui/protocol/transcriptWire.ts`. Same proven skeleton —
 * flatten to one item per content block, fingerprint each item so patches
 * apply idempotently, diff with an append fast path — plus what parity
 * required: progress messages are items now (keyed so in-place replacement
 * keeps a stable id), and attachments carry `type` + `display` (render
 * everywhere) with `data` as a progressive enhancement for rich renderers.
 *
 * Like its predecessor: a live transcript comes wholly through the stream.
 * Never splice a disk snapshot to a stream tail.
 */

import type { Message } from '../types/message.js'
import type {
  DomainContentBlock,
  DomainUserContentBlock,
} from '../types/domain.js'
import type { Attachment } from '../utils/attachments.js'
import { getAttachmentSystemReminderBodies } from '../utils/messages.js'
import type { WireAttachmentPayload, WireItem } from './wire.js'

const MAX_TEXT_BYTES = 64 * 1024

/**
 * FNV-1a. Not cryptographic: this only has to change when content changes,
 * and it runs on every streaming delta, so speed matters more than collision
 * resistance. (Same choice as the v1 projector, for the same reason.)
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

function finish(item: Omit<WireItem, 'rev'>): WireItem {
  // Hash everything except the id, so a resumed message with the same content
  // does not look changed.
  const { id: _id, ...rest } = item
  return { ...item, rev: fingerprint(JSON.stringify(rest)) }
}

/**
 * Strips synthetic XML-like tags from user message text (unchanged from v1:
 * a remote renderer receives plain text, so the tags go or get unwrapped at
 * the boundary).
 */
const STRIP_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-caveat',
  'bash-input',
  'system-reminder',
  'skill-format',
]
const UNWRAP_TAGS = [
  'local-command-stdout',
  'local-command-stderr',
  'bash-stdout',
  'bash-stderr',
]
function stripSyntheticTags(text: string): string {
  let result = text
  for (const tag of STRIP_TAGS) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
  }
  for (const tag of UNWRAP_TAGS) {
    result = result.replace(
      new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'),
      '$1',
    )
  }
  return result.trim()
}

/**
 * Attachment -> wire payload. `display` is computed for EVERY type (the
 * fallback one-liner is the type name, as v1 sent), so a brand-new internal
 * attachment type still renders remotely the moment it ships. `data` is
 * whitelisted per type: only fields a remote renderer actually consumes,
 * JSON-safe, never live handles or file contents beyond what the item shows.
 */
/**
 * Thinking duration stamped on the message at reasoning content_block_stop
 * (see `handleMessageFromStream`); absent when the host never measured one.
 */
function thinkingDurationMs(message: Message): number | undefined {
  const v = (message as unknown as { thinkingDurationMs?: unknown })
    .thinkingDurationMs
  return typeof v === 'number' ? v : undefined
}

function attachmentPayload(att: Record<string, any>): WireAttachmentPayload {
  const payload = attachmentFieldsFor(att)
  // The same derivation the classic REPL transcript does per render: the
  // reminder bodies an attachment injects. On the wire they let a remote
  // client show the classic collapsed row — real line count, expandable.
  try {
    const bodies = getAttachmentSystemReminderBodies(
      att as unknown as Attachment,
    )
    if (bodies.length > 0) payload.reminder = bodies.join('\n\n')
  } catch {
    // A shape from another version: the row falls back to `display`.
  }
  return payload
}

function attachmentFieldsFor(att: Record<string, any>): WireAttachmentPayload {
  const type = String(att.type ?? 'unknown')
  switch (type) {
    case 'file':
    case 'already_read_file':
    case 'compact_file_reference': {
      const path = String(att.displayPath ?? att.filename ?? '')
      return {
        type,
        display: path,
        data: { path, truncated: att.truncated === true },
      }
    }
    case 'pdf_reference':
      return {
        type,
        display: String(att.displayPath ?? att.filename ?? ''),
        data: {
          pageCount: att.pageCount,
          fileSize: att.fileSize,
          path: att.displayPath,
        },
      }
    case 'edited_text_file':
      return {
        type,
        display: String(att.filename ?? ''),
        data: { path: att.filename, snippet: clip(String(att.snippet ?? '')) },
      }
    case 'directory':
      return {
        type,
        display: String(att.displayPath ?? att.path ?? ''),
        data: {
          path: att.displayPath ?? att.path,
          listing: clip(String(att.content ?? '')),
        },
      }
    case 'diagnostics': {
      const files = Array.isArray(att.files) ? att.files : []
      const count = files.reduce(
        (n: number, f: any) =>
          n + (Array.isArray(f?.diagnostics) ? f.diagnostics.length : 0),
        0,
      )
      return {
        type,
        display: `${count} diagnostic${count === 1 ? '' : 's'}`,
        data: { files: att.files, isNew: att.isNew },
      }
    }
    case 'task_status':
      return {
        type,
        display: `${att.taskId}: ${att.status}`,
        data: {
          taskId: att.taskId,
          taskType: att.taskType,
          status: att.status,
          description: att.description,
          deltaSummary: att.deltaSummary ?? null,
        },
      }
    case 'token_usage':
    case 'budget_usd':
      return {
        type,
        display: `${att.used}/${att.total} (${
          type === 'token_usage' ? 'tokens' : 'USD'
        })`,
        data: { used: att.used, total: att.total, remaining: att.remaining },
      }
    case 'critical_system_reminder':
      return { type, display: clip(String(att.content ?? '')) }
    case 'plan_mode':
      return {
        type,
        display: 'plan mode',
        data: {
          reminderType: att.reminderType,
          planFilePath: att.planFilePath,
          planExists: att.planExists,
        },
      }
    case 'plan_mode_exit':
    case 'plan_mode_reentry':
      return {
        type,
        display: 'plan mode change',
        data: { path: att.planFilePath },
      }
    case 'hook_system_message':
      return {
        type,
        display: clip(String(att.content ?? '')),
        data: { hookName: att.hookName, hookEvent: att.hookEvent },
      }
    case 'mcp_resource':
      return {
        type,
        display: `${att.server}: ${att.name ?? att.uri}`,
        data: {
          server: att.server,
          uri: att.uri,
          name: att.name,
          description: att.description,
        },
      }
    case 'command_permissions':
      return {
        type,
        display: `permissions: ${(att.allowedTools ?? []).join(', ')}`,
        data: { allowedTools: att.allowedTools, model: att.model },
      }
    case 'structured_output':
      return { type, display: 'structured output', data: att.data }
    default:
      return { type, display: type }
  }
}

function userBlockItems(message: Message & { type: 'user' }): WireItem[] {
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

  const items: WireItem[] = []
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
        // An agent tool's receipt carries `agentId: <id>` in its text (launch
        // receipt and completion trailer). Surfacing it on the item is what
        // lets a remote client offer the sidechain drill-down for the call
        // the receipt answers — the tool_use block itself never learns the id.
        const agentReceipt = /agentId: ([A-Za-z0-9_-]{8,})/.exec(text)
        items.push(
          finish({
            ...base,
            id,
            kind: 'tool_result',
            text: clip(text),
            toolUseId: block.tool_use_id,
            isError: block.is_error === true ? true : undefined,
            // Only when found: a sidechain's own tool_result already carries
            // its agent's id via `base`, which an unconditional key would
            // overwrite with undefined.
            ...(agentReceipt ? { agentId: agentReceipt[1] } : {}),
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
): WireItem[] {
  const base = {
    timestamp: message.timestamp,
    isMeta: message.isMeta === true ? true : undefined,
    isSidechain: message.isSidechain,
    agentId: message.agentId,
    model: message.message.model,
    messageId: message.message.id,
  }

  const items: WireItem[] = []
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
          finish({
            ...base,
            id,
            kind: 'reasoning',
            text: clip(block.text),
            // Stamped on the message at reasoning content_block_stop —
            // the one authoritative thinking duration; the row says
            // `thought for Xs` remotely with it.
            ...(thinkingDurationMs(message) !== undefined
              ? { durationMs: thinkingDurationMs(message) }
              : {}),
          }),
        )
        break
      case 'redacted_reasoning':
        items.push(
          finish({
            ...base,
            id,
            kind: 'reasoning',
            text: '[redacted]',
            ...(thinkingDurationMs(message) !== undefined
              ? { durationMs: thinkingDurationMs(message) }
              : {}),
          }),
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

/** Flattens the transcript to wire items (see file header for the rules). */
export function toWireItems(messages: readonly Message[]): WireItem[] {
  const items: WireItem[] = []

  for (const message of messages) {
    switch (message.type) {
      case 'user':
        items.push(...userBlockItems(message))
        break
      case 'assistant':
        items.push(...assistantBlockItems(message))
        break
      case 'progress': {
        // v2 carries tool progress as items (keyed by the message uuid so the
        // core's in-place replacement patches one item, not a remove+add pair).
        const data = message.data as Record<string, any> | undefined
        items.push(
          finish({
            id: `${message.uuid}:0`,
            kind: 'progress',
            timestamp: message.timestamp,
            progress: {
              toolUseId: message.toolUseID,
              data: data,
            },
          }),
        )
        break
      }
      case 'attachment': {
        // Queued commands carry the user's prompt text. Serialize it as a
        // user item so every client shows what the user typed.
        const att = message.attachment as Record<string, any>
        if (att.type === 'queued_command') {
          const prompt = att.prompt
          const text =
            typeof prompt === 'string'
              ? prompt
              : Array.isArray(prompt)
                ? prompt
                    .filter(
                      (b: any): b is { type: 'text'; text: string } =>
                        b.type === 'text',
                    )
                    .map((b: any) => b.text)
                    .join('\n')
                : ''
          if (text) {
            items.push(
              finish({
                id: `${message.uuid}:0`,
                kind: 'user',
                timestamp: message.timestamp,
                isMeta: att.isMeta === true ? true : undefined,
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
            attachment: attachmentPayload(att),
          }),
        )
        break
      }
      case 'system': {
        const subtype = (message as { subtype?: string }).subtype
        if (
          subtype === 'compact_boundary' ||
          subtype === 'microcompact_boundary'
        ) {
          // The terminal hides the boundary row; a remote transcript still
          // needs the seam, or a long session reads as one continuous
          // conversation that happens to forget things. No text: the
          // subtype is the payload, and renderers draw a divider.
          items.push(
            finish({
              id: `${message.uuid}:0`,
              kind: 'system',
              timestamp: message.timestamp,
              text: '',
              subtype,
              isMeta: true,
            }),
          )
          break
        }
        items.push(
          finish({
            id: `${message.uuid}:0`,
            kind: 'system',
            timestamp: message.timestamp,
            text: clip(message.content ?? ''),
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

  return items
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== full[i]) return false
  }
  return true
}

/**
 * Diffs two item lists (same append fast-path reasoning as v1: resending the
 * whole order on every streaming delta is the difference between a few
 * hundred bytes and tens of kilobytes on a long transcript).
 */
export function wireSnapshot(items: WireItem[]): {
  items: WireItem[]
  order: string[]
} {
  return { items, order: items.map(i => i.id) }
}

export function diffWireSnapshots(
  previous: { items: WireItem[]; order: string[] },
  next: { items: WireItem[]; order: string[] },
): import('./wire.js').WireTranscriptPatch | null {
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
