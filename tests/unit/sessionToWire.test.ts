import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import {
  diffWireSnapshots,
  toWireItems,
  wireSnapshot,
} from '../../src/session/toWire.js'
import type { Message } from '../../src/types/message.js'

const ts = new Date(0).toISOString()

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: ts,
    message: { role: 'user', content: 'hello world' },
    ...overrides,
  } as unknown as Message
}

describe('toWire v2', () => {
  test('flattens user/assistant/progress/attachment/system', () => {
    const items = toWireItems([
      userMessage(),
      {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: ts,
        message: {
          role: 'assistant',
          model: 'test-model',
          id: 'msg_1',
          content: [
            { type: 'text', text: 'hi' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      } as unknown as Message,
      {
        type: 'progress',
        uuid: randomUUID(),
        timestamp: ts,
        toolUseID: 'tu_1',
        data: { type: 'bash_output', text: 'file1\n' },
      } as unknown as Message,
      {
        type: 'attachment',
        uuid: randomUUID(),
        timestamp: ts,
        attachment: {
          type: 'file',
          filename: '/x/a.ts',
          displayPath: 'a.ts',
          content: {},
        },
      } as unknown as Message,
      {
        type: 'system',
        uuid: randomUUID(),
        timestamp: ts,
        content: 'done in 3s',
        level: 'info',
      } as unknown as Message,
    ])

    const kinds = items.map(i => i.kind)
    expect(kinds).toEqual([
      'user',
      'assistant',
      'tool_use',
      'progress',
      'attachment',
      'system',
    ])
    expect(items[3].progress).toEqual({
      toolUseId: 'tu_1',
      data: { type: 'bash_output', text: 'file1\n' },
    })
    expect(items[4].attachment).toEqual({
      type: 'file',
      display: 'a.ts',
      data: { path: 'a.ts', truncated: false },
    })
    // Every item carries a fingerprint for idempotent patch application.
    for (const item of items) expect(item.rev).toMatch(/^[0-9a-z]+$/)
  })

  test('synthetic tags are stripped or unwrapped at the boundary', () => {
    const items = toWireItems([
      userMessage({
        message: {
          role: 'user',
          content:
            '<command-name>/cost</command-name><local-command-stdout>total: $1</local-command-stdout>',
        },
      } as any),
    ])
    expect(items[0].text).toBe('total: $1')
  })

  test('diff expresses appends compactly and reorders fully', () => {
    const first = userMessage()
    const second = userMessage()
    const a = wireSnapshot(toWireItems([first]))
    const b = wireSnapshot(toWireItems([first, second]))
    const patch = diffWireSnapshots(a, b)
    expect(patch?.type).toBe('delta')
    if (patch?.type !== 'delta') return
    expect(patch.upsert.length).toBe(1) // only the new message upserts
    expect(patch.orderAppend).toEqual(b.order.slice(1))

    const rewound = diffWireSnapshots(b, a)
    if (rewound?.type !== 'delta') throw new Error('expected delta')
    expect(rewound.remove).toEqual([b.order[1]])
    expect(rewound.order).toEqual(a.order)
  })

  test('rewriting a progress message in place keeps one item', () => {
    const uuid = randomUUID()
    const msg = (text: string): Message =>
      ({
        type: 'progress',
        uuid,
        timestamp: ts,
        toolUseID: 'tu_1',
        data: { type: 'bash_output', text },
      }) as unknown as Message
    const before = wireSnapshot(toWireItems([msg('a\n')]))
    const after = wireSnapshot(toWireItems([msg('a\nb\n')]))
    const patch = diffWireSnapshots(before, after)
    if (patch?.type !== 'delta') throw new Error('expected delta')
    expect(patch.upsert.length).toBe(1)
    expect(patch.remove.length).toBe(0)
    expect(patch.orderAppend).toBeUndefined() // same order
  })
})
