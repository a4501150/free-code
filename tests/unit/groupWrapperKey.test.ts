import { describe, expect, test } from 'bun:test'
import type { Tools } from '../../src/Tool.js'
import { TaskCreateTool } from '../../src/tools/TaskCreateTool/TaskCreateTool.js'
import { collapseReadSearchGroups } from '../../src/utils/collapseReadSearch.js'
import { applyGrouping, firstToolUseId } from '../../src/utils/groupToolUses.js'
import { deriveUUID } from '../../src/utils/messages.js'

const COLLAPSE_TOOLS = [TaskCreateTool] as unknown as Tools

const UUID_1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const UUID_2 = '11111111-2222-3333-4444-555555555555'

function toolUseMessage(uuid: string, id: string, name: string) {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-09-25T00:00:00Z',
    message: {
      id: 'msg_x',
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
  } as any
}

function groupUuidOf(
  messages: unknown[],
  pick: (m: { type: string }) => boolean,
): string | undefined {
  const out = collapseReadSearchGroups(messages as any, COLLAPSE_TOOLS)
  return (out.find(pick) as { uuid?: string } | undefined)?.uuid
}

// A streaming tool_use renders via a synthetic message whose uuid is
// deriveUUID(blockId, 0); at content_block_stop the committed message lands
// with a fresh random uuid. The wrapper row must keep one React key across
// that swap or it unmounts and remounts (flicker, lost expand state).
describe('wrapper row identity across synthetic → committed swap', () => {
  test('collapsed group uuid does not change when the first call commits', () => {
    const blockId = 'toolu_01AAAA00000000000000000001'
    const synth = deriveUUID(blockId as any, 0)

    const during = groupUuidOf(
      [toolUseMessage(synth, blockId, 'TaskCreate')],
      m => m.type === 'collapsed_read_search',
    )
    const after = groupUuidOf(
      [
        toolUseMessage(UUID_1, blockId, 'TaskCreate'),
        toolUseMessage(
          UUID_2,
          'toolu_02BBBB00000000000000000002',
          'TaskCreate',
        ),
      ],
      m => m.type === 'collapsed_read_search',
    )

    expect(during).toBeDefined()
    expect(after).toBe(during)
  })

  test('grouped tool use uuid does not change when the first call commits', () => {
    const blockId = 'toolu_01AAAA00000000000000000001'
    const synth = deriveUUID(blockId as any, 0)
    const groupingTools = [
      { name: 'Task', renderGroupedToolUse: () => null },
    ] as unknown as Tools

    const during = applyGrouping(
      [toolUseMessage(synth, blockId, 'Task')],
      groupingTools,
    ).messages.find(m => m.type === 'grouped_tool_use')
    const after = applyGrouping(
      [
        toolUseMessage(UUID_1, blockId, 'Task'),
        toolUseMessage(UUID_2, 'toolu_02BBBB00000000000000000002', 'Task'),
      ] as any,
      groupingTools,
    ).messages.find(m => m.type === 'grouped_tool_use')

    expect(during?.uuid).toBeDefined()
    expect(after?.uuid).toBe(during?.uuid)
  })

  test('identity falls back to message uuid for members without a tool_use', () => {
    const text = toolUseMessage(UUID_1, 'toolu_x', 'Task')
    text.message.content[0] = { type: 'text', text: 'hi' }
    expect(firstToolUseId(text)).toBe(UUID_1)
  })
})
