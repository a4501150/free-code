import { describe, expect, test } from 'bun:test'
import { BashTool } from '../../src/tools/BashTool/BashTool.js'
import type { CollapsedReadSearchGroup } from '../../src/types/message.js'
import { getPendingCollapsedCategories } from '../../src/utils/collapseReadSearch.js'

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

function group(messages: unknown[]): CollapsedReadSearchGroup {
  return {
    type: 'collapsed_read_search',
    searchCount: 0,
    readCount: 0,
    listCount: 0,
    memorySearchCount: 0,
    memoryReadCount: 0,
    memoryWriteCount: 0,
    readFilePaths: [],
    searchArgs: [],
    messages,
    displayMessage: messages[0],
    uuid: 'collapsed-test' as any,
    timestamp: '2026-09-13T00:00:00Z',
  }
}

const tools = [BashTool] as any

describe('getPendingCollapsedCategories', () => {
  test('a resolved call is not pending even while a sibling category runs', () => {
    const search = toolUseMessage('s1', 'Bash', { command: 'rg foo' })
    const bash = toolUseMessage('b1', 'Bash', { command: 'echo hi' })
    const pending = getPendingCollapsedCategories(
      group([search, bash]),
      tools,
      new Set(['b1']),
    )
    expect(pending.has('search')).toBe(true)
    expect(pending.has('bash')).toBe(false)
  })

  test('everything pending when nothing resolved, nothing pending when all resolved', () => {
    const search = toolUseMessage('s1', 'Bash', { command: 'rg foo' })
    const bash = toolUseMessage('b1', 'Bash', { command: 'echo hi' })
    const g = group([search, bash])
    const all = getPendingCollapsedCategories(g, tools, new Set())
    expect(all.has('search')).toBe(true)
    expect(all.has('bash')).toBe(true)
    const none = getPendingCollapsedCategories(g, tools, new Set(['s1', 'b1']))
    expect(none.size).toBe(0)
  })

  test('one pending call in a grouped message keeps its category pending', () => {
    const grouped = {
      type: 'grouped_tool_use',
      toolName: 'Bash',
      messages: [
        toolUseMessage('s1', 'Bash', { command: 'rg a' }),
        toolUseMessage('s2', 'Bash', { command: 'rg b' }),
      ],
    }
    const pending = getPendingCollapsedCategories(
      group([grouped]),
      tools,
      new Set(['s1']),
    )
    expect(pending.has('search')).toBe(true)
  })
})
