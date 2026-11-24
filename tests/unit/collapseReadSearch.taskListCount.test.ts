import { describe, expect, test } from 'bun:test'
import { TaskListTool } from '../../src/tools/TaskListTool/TaskListTool.tsx'
import { TaskUpdateTool } from '../../src/tools/TaskUpdateTool/TaskUpdateTool.ts'
import {
  collapseReadSearchGroups,
  getPendingCollapsedCategories,
} from '../../src/utils/collapseReadSearch.ts'
import type {
  CollapsedReadSearchGroup,
  RenderableMessage,
} from '../../src/types/message.js'

// TaskList must count into its own verb, never ride the TaskUpdate bucket —
// "Updated 1 task" for a list fetch mislabels the row (the collapse of the
// three write-path task tools shares the isTaskManagement arm).
const tools = [TaskListTool, TaskUpdateTool] as never as Parameters<
  typeof collapseReadSearchGroups
>[1]

const toolUse = (id: string, name: string, input: unknown): RenderableMessage =>
  ({
    type: 'assistant',
    uuid: id,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [{ type: 'tool_use', id, name, input }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }) as unknown as RenderableMessage

const groupCount = (
  group: CollapsedReadSearchGroup,
  key: 'taskListCount' | 'taskUpdateCount' | 'taskCreateCount',
): number => group[key] ?? 0

describe('taskListCount', () => {
  test('a TaskList call counts as a listed task list, not an update', () => {
    const groups = collapseReadSearchGroups(
      [toolUse('tl1', 'TaskList', {})],
      tools,
    )
    const group = groups[0] as CollapsedReadSearchGroup
    expect(group.type).toBe('collapsed_read_search')
    expect(groupCount(group, 'taskListCount')).toBe(1)
    expect(groupCount(group, 'taskUpdateCount')).toBe(0)
    expect(groupCount(group, 'taskCreateCount')).toBe(0)
  })

  test('TaskUpdate still counts into taskUpdateCount', () => {
    const groups = collapseReadSearchGroups(
      [toolUse('tu1', 'TaskUpdate', { taskId: '3', status: 'completed' })],
      tools,
    )
    const group = groups[0] as CollapsedReadSearchGroup
    expect(groupCount(group, 'taskUpdateCount')).toBe(1)
    expect(groupCount(group, 'taskListCount')).toBe(0)
  })

  test('a pending TaskList call pends the taskList category, not taskUpdate', () => {
    const groups = collapseReadSearchGroups(
      [toolUse('tl1', 'TaskList', {})],
      tools,
    )
    const pending = getPendingCollapsedCategories(
      groups[0] as CollapsedReadSearchGroup,
      tools,
      new Set(),
    )
    expect(pending.has('taskList')).toBe(true)
    expect(pending.has('taskUpdate')).toBe(false)
  })
})
