import { describe, expect, test } from 'bun:test'
import { renderTranscript } from '../../src/services/awaySummary.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../src/types/message.js'

let seq = 0
function user(content: unknown): UserMessage {
  return {
    type: 'user',
    uuid: `u${seq++}`,
    timestamp: '2026-10-08T00:00:00Z',
    message: { role: 'user', content },
  } as UserMessage
}
function assistant(content: unknown): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `a${seq++}`,
    timestamp: '2026-10-08T00:00:00Z',
    message: { role: 'assistant', content },
  } as unknown as AssistantMessage
}

describe('renderTranscript', () => {
  test('renders plain turns', () => {
    const out = renderTranscript([
      user('fix the venue images'),
      assistant([{ type: 'text', text: 'On it.' }]),
    ])
    expect(out).toBe('User: fix the venue images\nAssistant: On it.')
  })

  test('renders tool_use with clamped input JSON', () => {
    const out = renderTranscript([
      assistant([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'x'.repeat(1000) },
        },
      ]),
    ])
    expect(out).toMatch(/^\[Used Bash \{"command":"x+/)
    expect(out.length).toBeLessThan(350)
    expect(out).toMatch(/…\]$/)
  })

  test('labels tool_result via the tool_use id map', () => {
    const out = renderTranscript([
      assistant([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'file list' }]),
    ])
    expect(out).toContain('[Result of Bash: file list]')
  })

  test('falls back to a generic label for unmatched tool_result ids', () => {
    const out = renderTranscript([
      user([{ type: 'tool_result', tool_use_id: 'gone', content: 'ok' }]),
    ])
    expect(out).toBe('[Result of tool: ok]')
  })

  test('drops image and document blocks', () => {
    const out = renderTranscript([
      user([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AA' },
        },
        { type: 'text', text: 'look at this' },
      ]),
    ])
    expect(out).toBe('User: look at this')
  })

  test('skips virtual, non-message, and synthetic API-error messages', () => {
    const virtual = { ...user('hidden'), isVirtual: true }
    const apiError = {
      ...assistant([{ type: 'text', text: 'API error' }]),
      isApiErrorMessage: true,
    }
    const out = renderTranscript([
      virtual,
      {
        type: 'progress',
        uuid: 'p',
        timestamp: '',
        path: [],
      } as unknown as Message,
      apiError,
      user('visible'),
    ])
    expect(out).toBe('User: visible')
  })

  test('keeps the newest lines when over the byte cap', () => {
    const filler = 'y'.repeat(1000)
    const msgs: Message[] = []
    for (let i = 0; i < 50; i++)
      msgs.push(assistant([{ type: 'text', text: filler }]))
    const out = renderTranscript(msgs)
    const lines = out.split('\n')
    expect(lines[0]).toBe('… [older context omitted]')
    expect(lines.at(-1)).toBe(`Assistant: ${filler}`)
    expect(out.length).toBeLessThanOrEqual(20_000)
  })

  test('empty render for nothing renderable', () => {
    expect(renderTranscript([])).toBe('')
    expect(
      renderTranscript([user([{ type: 'image', source: {} }]) as Message]),
    ).toBe('')
  })
})
