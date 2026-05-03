import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
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
