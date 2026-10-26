/**
 * The session-context attachment group (session_guidance, the deferred/MCP
 * delta carriers, listings) must land ahead of the user message so the model reads
 * the context before the question it frames. These guards pin the reorder in
 * hoistContextGroupAttachments — the transcript persists this order, so a
 * regression here shifts persisted bytes, not just rendering.
 */
import { describe, expect, test } from 'bun:test'
import type { Attachment, Message } from '../../src/types/message.js'
import { hoistContextGroupAttachments } from '../../src/utils/attachments.js'

function userMsg(content: string): Message {
  return {
    type: 'user',
    uuid: `u-${content}`,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: content }] },
  } as unknown as Message
}

function attach(attachment: Attachment): Message {
  return {
    type: 'attachment',
    uuid: `a-${attachment.type}`,
    timestamp: new Date().toISOString(),
    attachment,
  } as Message
}

function group(type: Attachment['type']): Message {
  return attach({ type } as Attachment)
}

function types(messages: Message[]): string[] {
  return messages.map(m =>
    m.type === 'attachment' ? `attachment:${m.attachment.type}` : m.type,
  )
}

describe('hoistContextGroupAttachments', () => {
  test('moves the context group ahead of the user message', () => {
    const out = hoistContextGroupAttachments([
      userMsg('hello'),
      group('session_guidance'),
      group('already_read_file'),
      group('skill_listing'),
    ])
    expect(types(out)).toEqual([
      'attachment:session_guidance',
      'attachment:skill_listing',
      'user',
      'attachment:already_read_file',
    ])
  })

  test('preserves relative order within the group and the remainder', () => {
    const out = hoistContextGroupAttachments([
      userMsg('hello'),
      group('mcp_tools_delta'),
      group('git_instructions'),
      attach({ type: 'diagnostics' } as Attachment),
      group('session_guidance'),
    ])
    expect(types(out)).toEqual([
      'attachment:mcp_tools_delta',
      'attachment:git_instructions',
      'attachment:session_guidance',
      'user',
      'attachment:diagnostics',
    ])
  })

  test('leaves the array untouched when nothing matches', () => {
    const input = [
      userMsg('hello'),
      attach({ type: 'nested_memory' } as Attachment),
    ]
    expect(hoistContextGroupAttachments(input)).toBe(input)
  })

  test('leaves the array untouched without a user message', () => {
    const input = [group('session_guidance'), group('skill_listing')]
    expect(hoistContextGroupAttachments(input)).toBe(input)
  })
})
