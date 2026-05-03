import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import type { Message } from '../../src/types/message.js'
import { normalizeMessagesForAPI } from '../../src/utils/messages.js'

function assistantMessage(content: unknown[]): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-05-03T00:00:00.000Z',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,
    },
  } as Message
}

function userToolResult(toolUseId: string, content: unknown): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-05-03T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
    toolUseResult: content,
  } as Message
}

describe('normalizeMessagesForAPI legacy ToolSearch cleanup', () => {
  test('removes completed legacy ToolSearch exchanges from API-bound history', () => {
    const normalized = normalizeMessagesForAPI(
      [
        assistantMessage([
          {
            type: 'tool_use',
            id: 'toolu_toolsearch',
            name: 'ToolSearch',
            input: { query: 'read files' },
          },
        ]),
        userToolResult('toolu_toolsearch', 'loaded Read'),
        assistantMessage([
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: { file_path: '/tmp/example.ts' },
          },
        ]),
        userToolResult('toolu_read', 'file contents'),
      ],
      [FileReadTool],
    )

    expect(normalized).toHaveLength(2)
    expect(normalized[0]?.type).toBe('assistant')
    expect(
      normalized[0]?.type === 'assistant'
        ? normalized[0].message.content[0]
        : null,
    ).toMatchObject({ type: 'tool_use', id: 'toolu_read', name: 'Read' })
    expect(normalized[1]?.type).toBe('user')
    expect(
      normalized[1]?.type === 'user' ? normalized[1].message.content[0] : null,
    ).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_read' })
  })

  test('strips legacy tool_reference blocks from tool results', () => {
    const normalized = normalizeMessagesForAPI([
      userToolResult('toolu_toolsearch', [
        { type: 'text', text: 'loaded' },
        { type: 'tool_reference', tool_name: 'Read' },
      ]),
    ])

    expect(normalized).toHaveLength(1)
    const content =
      normalized[0]?.type === 'user' ? normalized[0].message.content : []
    const toolResult = Array.isArray(content) ? content[0] : null
    expect(toolResult).toMatchObject({ type: 'tool_result' })
    expect(
      toolResult?.type === 'tool_result' ? toolResult.content : null,
    ).toEqual([{ type: 'text', text: 'loaded' }])
  })

  test('strips legacy caller fields from assistant tool uses', () => {
    const normalized = normalizeMessagesForAPI(
      [
        assistantMessage([
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: { file_path: '/tmp/example.ts' },
            caller: 'toolu_toolsearch',
          },
        ]),
      ],
      [FileReadTool],
    )

    const block =
      normalized[0]?.type === 'assistant'
        ? normalized[0].message.content[0]
        : null
    expect(block).toEqual({
      type: 'tool_use',
      id: 'toolu_read',
      name: 'Read',
      input: { file_path: '/tmp/example.ts' },
    })
  })
})
