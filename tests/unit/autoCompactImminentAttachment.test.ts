import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import { getAutoCompactImminentAttachment } from '../../src/utils/attachments.js'
import {
  getAutoCompactThreshold,
  WARNING_THRESHOLD_BUFFER_TOKENS,
} from '../../src/services/compact/autoCompact.js'
import { getAttachmentSystemReminderBodies } from '../../src/utils/messages.js'

const MODEL = 'openai:gpt-5.5'

// Derived from the live config rather than hardcoded: the threshold depends on
// the model's context window and the user's autoCompactPercentage/Buffer.
const THRESHOLD = getAutoCompactThreshold(MODEL)
const WARNING_AT = THRESHOLD - WARNING_THRESHOLD_BUFFER_TOKENS

function assistantMessageUsing(tokens: number): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: crypto.randomUUID(),
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: tokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as Message
}

function imminentAttachmentMessage(): Message {
  return {
    type: 'attachment',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: { type: 'auto_compact_imminent' },
  } as Message
}

beforeEach(() => {
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
})

afterEach(() => {
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
})

describe('auto-compact imminent attachment', () => {
  test('the warning band sits below the auto-compact trigger', () => {
    expect(WARNING_AT).toBeGreaterThan(0)
    expect(WARNING_AT).toBeLessThan(THRESHOLD)
  })

  test('stays silent well below the warning threshold', () => {
    const messages = [assistantMessageUsing(Math.floor(WARNING_AT / 2))]

    expect(getAutoCompactImminentAttachment(messages, MODEL)).toEqual([])
  })

  test('fires once the warning threshold is crossed', () => {
    const messages = [assistantMessageUsing(WARNING_AT + 1_000)]

    expect(getAutoCompactImminentAttachment(messages, MODEL)).toEqual([
      { type: 'auto_compact_imminent' },
    ])
  })

  test('does not fire twice in the same compaction window', () => {
    const messages = [
      imminentAttachmentMessage(),
      assistantMessageUsing(WARNING_AT + 1_000),
    ]

    expect(getAutoCompactImminentAttachment(messages, MODEL)).toEqual([])
  })

  test('stays silent when auto-compact is disabled', () => {
    process.env.DISABLE_AUTO_COMPACT = '1'
    const messages = [assistantMessageUsing(WARNING_AT + 1_000)]

    expect(getAutoCompactImminentAttachment(messages, MODEL)).toEqual([])
  })

  // shouldHideAttachmentInUI keeps a no-summary-line attachment only when it
  // contributes a reminder body, so an empty body here would hide the row.
  test('materializes as a system reminder', () => {
    const bodies = getAttachmentSystemReminderBodies({
      type: 'auto_compact_imminent',
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('compacted automatically')
  })
})
