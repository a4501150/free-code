import { describe, expect, test } from 'bun:test'
import {
  createItemKeyCache,
  syncItemKeys,
} from '../../src/components/virtualItemKeys.js'
import type { RenderableMessage } from '../../src/types/message.js'
import { reorderMessagesInUI } from '../../src/utils/messages.js'

const CONVERSATION_ID = 'conv-1'
const itemKey = (msg: RenderableMessage) => `${msg.uuid}-${CONVERSATION_ID}`

// A fresh object per call: normalizeMessages rebuilds every message object on
// each recompute, so the cache can never rely on object identity.
function row(uuid: string): RenderableMessage {
  return { type: 'user', uuid, timestamp: '', message: {} } as RenderableMessage
}

function toolUse(uuid: string, id: string): RenderableMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '',
    message: { role: 'assistant', content: [{ type: 'tool_use', id }] },
  } as unknown as RenderableMessage
}

function toolResult(uuid: string, id: string): RenderableMessage {
  return {
    type: 'user',
    uuid,
    timestamp: '',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id }],
    },
  } as unknown as RenderableMessage
}

function expectAligned(keys: string[], messages: RenderableMessage[]): void {
  expect(keys).toEqual(messages.map(itemKey))
  expect(new Set(keys).size).toBe(keys.length)
}

describe('syncItemKeys', () => {
  test('appends keys for messages added at the tail', () => {
    const cache = createItemKeyCache()
    const first = [row('a'), row('b')]
    const firstKeys = syncItemKeys(cache, first, itemKey)
    expectAligned(firstKeys, first)

    const grown = [row('a'), row('b'), row('c')]
    const grownKeys = syncItemKeys(cache, grown, itemKey)
    expectAligned(grownKeys, grown)
    // Reused in place — the point of the incremental path.
    expect(grownKeys).toBe(firstKeys)
  })

  test('rebuilds when a row is inserted before the tail', () => {
    const cache = createItemKeyCache()
    syncItemKeys(cache, [row('a'), row('b'), row('c')], itemKey)

    const inserted = [row('a'), row('b'), row('x'), row('c')]
    expectAligned(syncItemKeys(cache, inserted, itemKey), inserted)
  })

  test('rebuilds when a row is replaced in place', () => {
    const cache = createItemKeyCache()
    syncItemKeys(cache, [row('a'), row('placeholder')], itemKey)

    const replaced = [row('a'), row('real')]
    expectAligned(syncItemKeys(cache, replaced, itemKey), replaced)
  })

  test('rebuilds when the list shrinks', () => {
    const cache = createItemKeyCache()
    syncItemKeys(cache, [row('a'), row('b'), row('c')], itemKey)

    const shrunk = [row('a')]
    expectAligned(syncItemKeys(cache, shrunk, itemKey), shrunk)
  })

  test('rebuilds when itemKey changes', () => {
    const cache = createItemKeyCache()
    const messages = [row('a'), row('b')]
    syncItemKeys(cache, messages, itemKey)

    const otherKey = (msg: RenderableMessage) => `${msg.uuid}-conv-2`
    expect(syncItemKeys(cache, messages, otherKey)).toEqual([
      'a-conv-2',
      'b-conv-2',
    ])
  })

  test('stays aligned when parallel tool results arrive out of order', () => {
    // reorderMessagesInUI moves each result up beside its tool_use, so the
    // late result for the first call is inserted before the tail rather than
    // appended. This is the sequence that duplicated a key.
    const callA = toolUse('use-a', 'id-a')
    const callB = toolUse('use-b', 'id-b')
    const resultA = toolResult('res-a', 'id-a')
    const resultB = toolResult('res-b', 'id-b')

    const cache = createItemKeyCache()
    const bDone = reorderMessagesInUI(
      [callA, callB, resultB] as never,
      [],
    ) as RenderableMessage[]
    expect(bDone.map(m => m.uuid)).toEqual(['use-a', 'use-b', 'res-b'])
    expectAligned(syncItemKeys(cache, bDone, itemKey), bDone)

    const bothDone = reorderMessagesInUI(
      [callA, callB, resultB, resultA] as never,
      [],
    ) as RenderableMessage[]
    expect(bothDone.map(m => m.uuid)).toEqual([
      'use-a',
      'res-a',
      'use-b',
      'res-b',
    ])
    expectAligned(syncItemKeys(cache, bothDone, itemKey), bothDone)
  })
})
