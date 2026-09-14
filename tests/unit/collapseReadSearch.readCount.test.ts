import { describe, expect, test } from 'bun:test'
import { BashTool } from '../../src/tools/BashTool/BashTool.js'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import { collapseReadSearchGroups } from '../../src/utils/collapseReadSearch.js'

const tools = [FileReadTool, BashTool] as any

function toolUseMessage(
  id: string,
  name: string,
  input: Record<string, unknown>,
) {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    timestamp: '2026-09-13T00:00:00Z',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  } as any
}

function readCountOf(messages: unknown[]): number {
  const collapsed = collapseReadSearchGroups(messages as any, tools)
  const group = collapsed.find(m => m.type === 'collapsed_read_search') as any
  return group?.readCount ?? 0
}

describe('collapseReadSearchGroups readCount', () => {
  test('two Read calls on one file count as one file', () => {
    expect(
      readCountOf([
        toolUseMessage('r1', 'Read', { file_path: '/tmp/a.ts' }),
        toolUseMessage('r2', 'Read', { file_path: '/tmp/a.ts' }),
      ]),
    ).toBe(1)
  })

  test('a mid-stream Read without file_path is not counted as an operation', () => {
    // Streaming synthetic messages can lack file_path while the input JSON
    // is still arriving. Counting them (before the paths land) rendered
    // "Reading 2 files…" that ticked down to "Read 1 file" on completion.
    const midStream = [
      toolUseMessage('r1', 'Read', {}),
      toolUseMessage('r2', 'Read', {}),
    ]
    expect(readCountOf(midStream)).toBe(0)
    // …and once both inputs complete the group shows 1, so the count
    // transitions 0 → 1 and only ever grows.
    expect(
      readCountOf([
        toolUseMessage('r1', 'Read', { file_path: '/tmp/a.ts' }),
        toolUseMessage('r2', 'Read', { file_path: '/tmp/a.ts' }),
      ]),
    ).toBe(1)
  })

  test('a completed Read beside a mid-stream Read shows one file', () => {
    expect(
      readCountOf([
        toolUseMessage('r1', 'Read', { file_path: '/tmp/a.ts' }),
        toolUseMessage('r2', 'Read', {}),
      ]),
    ).toBe(1)
  })

  test('pathless Bash read commands still count as operations', () => {
    expect(
      readCountOf([
        toolUseMessage('b1', 'Bash', { command: 'cat /tmp/a.txt' }),
        toolUseMessage('b2', 'Bash', { command: 'head -5 /tmp/b.txt' }),
      ]),
    ).toBe(2)
  })
})
