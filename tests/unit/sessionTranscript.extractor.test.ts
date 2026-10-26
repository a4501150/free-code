import { describe, expect, test } from 'bun:test'
import { extractTranscriptEntry } from '../../src/services/sessionTranscript/sessionTranscript.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utils/messages.js'

/**
 * The /dream segment flush (compact + assistant /clear paths) feeds REAL
 * domain messages into extractTranscriptEntry: role lives at
 * `message.role` and content at `message.content`, not at the top level.
 * A previous version read top-level `m.role` and silently flushed nothing.
 */
describe('extractTranscriptEntry', () => {
  test('user message with string content', () => {
    const msg = createUserMessage({ content: 'hello dream' })
    const entry = extractTranscriptEntry(msg)
    expect(entry).not.toBeNull()
    expect(entry!.role).toBe('user')
    expect(entry!.text).toBe('hello dream')
    expect(typeof entry!.ts).toBe('string')
  })

  test('user message with text blocks joins them', () => {
    const msg = createUserMessage({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ] as any,
    })
    const entry = extractTranscriptEntry(msg)
    expect(entry!.role).toBe('user')
    expect(entry!.text).toBe('first\nsecond')
  })

  test('assistant message extracts text blocks', () => {
    const msg = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'assistant says hi' },
      ] as any,
    })
    const entry = extractTranscriptEntry(msg)
    expect(entry!.role).toBe('assistant')
    expect(entry!.text).toBe('assistant says hi')
  })

  test('tool_use-only assistant message is skipped', () => {
    const msg = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ] as any,
    })
    expect(extractTranscriptEntry(msg)).toBeNull()
  })

  test('tool_result-only user message is skipped', () => {
    const msg = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: 'output',
        },
      ] as any,
    })
    expect(extractTranscriptEntry(msg)).toBeNull()
  })

  test('progress/system messages without a role are skipped', () => {
    expect(extractTranscriptEntry({ type: 'progress' })).toBeNull()
    expect(extractTranscriptEntry(null)).toBeNull()
    expect(extractTranscriptEntry('nope')).toBeNull()
  })

  test('flat {role, content} shapes still map (legacy path)', () => {
    const entry = extractTranscriptEntry({
      role: 'user',
      content: [{ type: 'text', text: 'flat' }],
    })
    expect(entry!.role).toBe('user')
    expect(entry!.text).toBe('flat')
  })

  test('long text is capped at 10k chars with ellipsis', () => {
    const msg = createUserMessage({ content: 'x'.repeat(10_001) })
    const entry = extractTranscriptEntry(msg)
    expect((entry!.text as string).length).toBe('...'.length + 10_000)
    expect((entry!.text as string).endsWith('...')).toBe(true)
  })
})
