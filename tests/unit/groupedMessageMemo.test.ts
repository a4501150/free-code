import { describe, expect, test } from 'bun:test'
import { areMessagePropsEqual } from '../../src/components/Message.js'
import type { GroupedToolUseMessage } from '../../src/types/message.js'

function groupedMessage(memberIds: string[]) {
  return {
    type: 'grouped_tool_use',
    toolName: 'Agent',
    // Wrapper uuid is keyed off the FIRST member's tool_use id and must stay
    // stable across the synthetic→committed swap and across member growth.
    uuid: `grouped-${memberIds[0]}`,
    messages: memberIds.map(id => ({
      type: 'assistant',
      uuid: `msg-${id}`,
      message: {
        id: 'resp_1',
        content: [{ type: 'tool_use', id, name: 'Agent', input: {} }],
      },
    })),
    results: [],
  } as unknown as GroupedToolUseMessage
}

function props(message: unknown, isStatic: boolean) {
  return {
    message,
    verbose: false,
    isTranscriptMode: false,
    isStatic,
    latestBashOutputUUID: null,
  } as never
}

describe('areMessagePropsEqual with growing grouped tool-use rows', () => {
  test('member growth forces a re-render even when both renders are static', () => {
    const one = groupedMessage(['toolu_1'])
    const two = groupedMessage(['toolu_1', 'toolu_2'])

    // Parallel backgrounded agents land tool_use + result in the same React
    // batch, so the group is fully resolved (static) at every growth step.
    expect(areMessagePropsEqual(props(one, true), props(two, true))).toBe(false)
  })

  test('same member count still bails for a static grouped row', () => {
    const one = groupedMessage(['toolu_1'])
    const oneAgain = groupedMessage(['toolu_1'])

    expect(areMessagePropsEqual(props(one, true), props(oneAgain, true))).toBe(
      true,
    )
  })

  test('non-grouped static messages keep the uuid-based bail', () => {
    const assistant = {
      type: 'assistant',
      uuid: 'msg_1',
      message: { id: 'resp_1', content: [{ type: 'text', text: 'hi' }] },
    }

    expect(
      areMessagePropsEqual(props(assistant, true), props(assistant, true)),
    ).toBe(true)
  })
})
