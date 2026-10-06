import { describe, expect, test } from 'bun:test'
import { BashTool } from '../../src/tools/BashTool/BashTool.tsx'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.ts'
import {
  collapseReadSearchGroups,
  getPendingCollapsedCategories,
} from '../../src/utils/collapseReadSearch.ts'
import type {
  CollapsedReadSearchGroup,
  RenderableMessage,
} from '../../src/types/message.js'

// Same two real tools as the readCount test: Bash is the bucket under test,
// FileRead keeps a resolved Read out of the bash bucket.
const tools = [BashTool, FileReadTool] as never as Parameters<
  typeof collapseReadSearchGroups
>[1]

const bash = (id: string, input: unknown): RenderableMessage =>
  ({
    type: 'assistant',
    uuid: id,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [{ type: 'tool_use', id, name: 'Bash', input }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }) as unknown as RenderableMessage

const read = (id: string, file_path: string): RenderableMessage =>
  ({
    type: 'assistant',
    uuid: id,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path } }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }) as unknown as RenderableMessage

const result = (id: string): RenderableMessage =>
  ({
    type: 'user',
    uuid: `${id}-result`,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    },
  }) as unknown as RenderableMessage

const textBreaker = (): RenderableMessage =>
  ({
    type: 'assistant',
    uuid: 'breaker',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      id: 'breaker',
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }) as unknown as RenderableMessage

function summarize(messages: RenderableMessage[]): CollapsedReadSearchGroup {
  const collapsed = collapseReadSearchGroups(messages, tools)
  const group = collapsed.find(m => m.type === 'collapsed_read_search') as
    | CollapsedReadSearchGroup
    | undefined
  expect(group).toBeDefined()
  return group!
}

describe('collapse groups — bash bucket', () => {
  test('a resolved plain command counts', () => {
    const g = summarize([
      bash('b1', { command: 'npm test' }),
      result('b1'),
      textBreaker(),
    ])
    expect(g.bashCount).toBe(1)
  })

  test('an unexecuted command counts but holds the bash category pending', () => {
    // Input fully committed, no tool_result — the call is classified (a
    // completed input can no longer move buckets), so it counts; the
    // renderer keeps the section in present tense ("Running…") while the
    // category is pending.
    const messages = [bash('b1', { command: 'npm test' }), textBreaker()]
    const g = summarize(messages)
    expect(g.bashCount).toBe(1)
    const pending = getPendingCollapsedCategories(g, tools, new Set())
    expect(pending.has('bash')).toBe(true)
    // Once the result resolves the id, the section flips to past tense.
    expect(
      getPendingCollapsedCategories(g, tools, new Set(['b1'])).has('bash'),
    ).toBe(false)
  })

  test('a Bash call mid-stream (input JSON still parsing) is not collapsible at all', () => {
    // Regression: a synthetic streaming Bash message with an empty input
    // object was bucketed as "not a search/read" and pinned "ran 1 bash
    // command" beside the search it was about to become. It must instead
    // render as a pending standalone tool row: excluded from the group, no
    // bucket, until its `command` parses.
    const collapsed = collapseReadSearchGroups(
      [
        bash('s1', { command: 'rg -n TODO src | head -20' }),
        result('s1'),
        read('r1', '/tmp/x.ts'),
        result('r1'),
        bash('b1', {}),
        textBreaker(),
      ],
      tools,
    )
    const g = collapsed.find(
      m => m.type === 'collapsed_read_search',
    ) as CollapsedReadSearchGroup
    expect(g.searchCount).toBe(1)
    expect(g.readCount).toBe(1)
    expect(g.bashCount ?? 0).toBe(0)
    // The streaming call passes through as its own row, after the group.
    const streamingRow = collapsed.find(
      m => m.type === 'assistant' && m.message.content[0]?.id === 'b1',
    )
    expect(streamingRow).toBeDefined()
  })

  test('the streaming call counts as its completed command once executed', () => {
    const g = summarize([
      bash('s1', { command: 'rg -n TODO src | head -20' }),
      result('s1'),
      bash('b1', { command: 'npm test' }),
      result('b1'),
      textBreaker(),
    ])
    expect(g.searchCount).toBe(1)
    expect(g.bashCount).toBe(1)
  })
})
