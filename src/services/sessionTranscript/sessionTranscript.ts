/**
 * Session transcript persistence for assistant mode.
 *
 * Writes conversation transcript segments as JSONL files, organized by date.
 * Transcripts are written during compaction and on date boundaries so the
 * /dream skill can access recent conversation history for memory consolidation.
 *
 * Storage layout:
 *   ~/.freecode/sessions/<session-id>/transcript/YYYY-MM-DD.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getAssistantActive } from '../../bootstrap/state.js'
import { logError } from '../../utils/log.js'
import { getContentText } from '../../utils/messages.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

function getTranscriptDir(): string {
  return join(
    getClaudeConfigHomeDir(),
    'sessions',
    getSessionId(),
    'transcript',
  )
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function dateFromMessage(msg: unknown): string | null {
  if (msg && typeof msg === 'object') {
    // Try common message timestamp patterns
    const m = msg as Record<string, unknown>
    if (typeof m.timestamp === 'string') {
      return m.timestamp.slice(0, 10) // YYYY-MM-DD
    }
    if (typeof m.createdAt === 'string') {
      return m.createdAt.slice(0, 10)
    }
  }
  return null
}

/**
 * Map a message to a transcript line. Handles domain messages
 * (UserMessage/AssistantMessage), which nest role at `message.role` and
 * content at `message.content` (see src/utils/messages.ts create* helpers),
 * plus flat {role, content} shapes. Tool-only messages (no text blocks)
 * produce no entry. Exported for tests.
 */
export function extractTranscriptEntry(
  msg: unknown,
): Record<string, unknown> | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>

  // Domain messages carry the API payload under `message`; the top-level
  // `type` field is the message kind, not the role.
  const inner =
    m.message && typeof m.message === 'object'
      ? (m.message as Record<string, unknown>)
      : undefined
  const role =
    typeof inner?.role === 'string'
      ? (inner.role as string)
      : typeof m.role === 'string'
        ? m.role
        : undefined
  if (!role) return null

  const content = inner ? inner.content : m.content
  const text = getContentText(content as string) ?? ''

  if (!text) return null

  return {
    role,
    text: text.length > 10_000 ? `${text.slice(0, 10_000)}...` : text,
    ts: new Date().toISOString(),
  }
}

/**
 * Write a transcript segment for a batch of messages (called during compaction).
 * Fire-and-forget — errors are logged internally.
 */
export function writeSessionTranscriptSegment(messages: unknown[]): void {
  if (!getAssistantActive()) return
  try {
    const dir = getTranscriptDir()
    ensureDir(dir)

    const today = new Date().toISOString().slice(0, 10)
    const filePath = join(dir, `${today}.jsonl`)

    const lines: string[] = []
    for (const msg of messages) {
      const entry = extractTranscriptEntry(msg)
      if (entry) {
        lines.push(JSON.stringify(entry))
      }
    }

    if (lines.length > 0) {
      appendFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    }
  } catch (err) {
    logError(err)
  }
}

/**
 * Flush transcripts on date change. Checks if messages span a date boundary
 * and writes any messages from the previous day to that day's file.
 */
export function flushOnDateChange(
  messages: unknown[],
  currentDate: string,
): void {
  if (!getAssistantActive()) return
  try {
    const dir = getTranscriptDir()
    ensureDir(dir)

    // Group messages by date and write to respective files
    const byDate = new Map<string, unknown[]>()
    for (const msg of messages) {
      const msgDate = dateFromMessage(msg) ?? currentDate
      const dateKey = msgDate.slice(0, 10)
      if (dateKey !== currentDate) {
        const existing = byDate.get(dateKey) ?? []
        existing.push(msg)
        byDate.set(dateKey, existing)
      }
    }

    // Write previous days' messages to their respective files
    for (const [dateKey, msgs] of byDate) {
      const filePath = join(dir, `${dateKey}.jsonl`)
      const lines: string[] = []
      for (const msg of msgs) {
        const entry = extractTranscriptEntry(msg)
        if (entry) {
          lines.push(JSON.stringify(entry))
        }
      }
      if (lines.length > 0) {
        appendFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
      }
    }
  } catch (err) {
    logError(err)
  }
}
