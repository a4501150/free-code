import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
  pruneMessagesToLastCompactBoundary,
} from '../../src/utils/messages.js'

function userMessage(content: string): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-05-03T00:00:00.000Z',
    message: {
      role: 'user',
      content,
    },
  } as Message
}

describe('getMessagesAfterCompactBoundary', () => {
  test('returns all messages when no compact boundary exists', () => {
    const messages = [userMessage('one'), userMessage('two')]

    expect(getMessagesAfterCompactBoundary(messages)).toEqual(messages)
  })

  test('returns messages from the last compact boundary onward', () => {
    const beforeFirst = userMessage('before first')
    const firstBoundary = createCompactBoundaryMessage('manual', 100)
    const between = userMessage('between')
    const secondBoundary = createCompactBoundaryMessage('auto', 200)
    const afterSecond = userMessage('after second')

    expect(
      getMessagesAfterCompactBoundary([
        beforeFirst,
        firstBoundary,
        between,
        secondBoundary,
        afterSecond,
      ]),
    ).toEqual([secondBoundary, afterSecond])
  })
})

describe('pruneMessagesToLastCompactBoundary', () => {
  test('prunes in place, keeping array identity and the boundary onward', () => {
    const before = userMessage('before')
    const boundary = createCompactBoundaryMessage('manual', 100)
    const after = userMessage('after')
    const messages = [before, boundary, after]
    const identity = messages

    const pruned = pruneMessagesToLastCompactBoundary(messages)

    expect(pruned).toBe(true)
    expect(messages).toBe(identity)
    expect(messages).toEqual([boundary, after])
  })

  test('returns false and leaves the array alone when no boundary exists', () => {
    const messages = [userMessage('one'), userMessage('two')]
    const identity = messages

    const pruned = pruneMessagesToLastCompactBoundary(messages)

    expect(pruned).toBe(false)
    expect(messages).toBe(identity)
    expect(messages.length).toBe(2)
  })

  test('boundary at index 0 is a no-op', () => {
    const boundary = createCompactBoundaryMessage('manual', 100)
    const after = userMessage('after')
    const messages = [boundary, after]

    expect(pruneMessagesToLastCompactBoundary(messages)).toBe(false)
    expect(messages).toEqual([boundary, after])
  })

  test('prunes to the LAST boundary when several exist', () => {
    const firstBoundary = createCompactBoundaryMessage('manual', 100)
    const between = userMessage('between')
    const secondBoundary = createCompactBoundaryMessage('auto', 200)
    const after = userMessage('after')
    const messages = [
      userMessage('old'),
      firstBoundary,
      between,
      secondBoundary,
      after,
    ]

    expect(pruneMessagesToLastCompactBoundary(messages)).toBe(true)
    expect(messages).toEqual([secondBoundary, after])
  })

  test('empty array is a no-op', () => {
    expect(pruneMessagesToLastCompactBoundary([])).toBe(false)
  })
})
