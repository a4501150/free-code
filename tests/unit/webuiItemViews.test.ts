import { describe, expect, test } from 'bun:test'
import {
  agentIdsByToolUse,
  attachmentGutter,
  attachmentView,
  compactDividerText,
  progressView,
  taskView,
  toolNamesByUseId,
} from '../../src/webui/client/itemViews.js'
import type { WireItem } from '../../src/session/wire.js'

function item(overrides: Partial<WireItem>): WireItem {
  return {
    id: 'i1',
    kind: 'progress',
    timestamp: 0,
    rev: 'r',
    ...overrides,
  } as WireItem
}

describe('progressView', () => {
  const toolNames = new Map([['tu_1', 'Bash']])

  test('labels the tool by its use id', () => {
    const view = progressView(
      item({ progress: { toolUseId: 'tu_1', data: { type: 'bash_output' } } }),
      toolNames,
    )
    expect(view).toEqual({ label: 'Bash', detail: 'bash_output' })
  })

  test('prefers a human message field over the data type', () => {
    const view = progressView(
      item({
        progress: {
          toolUseId: 'tu_x',
          toolName: 'Agent',
          data: { type: 'x', message: '  searching files  ' },
        },
      }),
      toolNames,
    )
    expect(view).toEqual({ label: 'Agent', detail: 'searching files' })
  })

  test('falls back to a neutral label without any tool binding', () => {
    expect(progressView(item({ progress: {} }), toolNames)).toEqual({
      label: 'tool',
      detail: undefined,
    })
    expect(progressView(item({}), toolNames)).toBeNull()
  })

  test('non-object data has no detail line', () => {
    expect(
      progressView(
        item({ progress: { toolUseId: 'tu_1', data: 'x' } }),
        toolNames,
      )?.detail,
    ).toBeUndefined()
  })
})

describe('toolNamesByUseId', () => {
  test('collects names from tool_use items only', () => {
    const map = toolNamesByUseId([
      item({ kind: 'tool_use', toolUseId: 'a', toolName: 'Bash' }),
      item({ kind: 'tool_use', toolUseId: 'b' }),
      item({ kind: 'tool_result', toolUseId: 'a' }),
    ])
    expect([...map.entries()]).toEqual([['a', 'Bash']])
  })
})

describe('attachmentView', () => {
  const att = (type: string, display: string, data?: unknown) =>
    item({ kind: 'attachment', attachment: { type, display, data } })

  test('read rows name the path', () => {
    expect(
      attachmentView(att('file', 'a.ts', { path: 'a.ts', truncated: true })),
    ).toEqual({
      cls: 'is-file',
      label: 'read a.ts',
      detail: 'truncated for the model',
    })
    expect(
      attachmentView(
        att('compact_file_reference', 'b.ts', {
          path: 'b.ts',
          truncated: false,
        }),
      )?.label,
    ).toBe('referenced b.ts')
  })

  test('edit and listing rows carry a mono snippet', () => {
    const edited = attachmentView(
      att('edited_text_file', 'a.ts', { path: 'a.ts', snippet: '+x' }),
    )
    expect(edited).toEqual({
      cls: 'is-edited_text_file',
      label: 'edited a.ts',
      detail: '+x',
      mono: true,
    })
    const dir = attachmentView(
      att('directory', 'src', { path: 'src', listing: 'a.ts\nb.ts' }),
    )
    expect(dir?.detail).toBe('a.ts\nb.ts')
    expect(dir?.mono).toBe(true)
  })

  test('task status rows key their class off the status', () => {
    const view = attachmentView(
      att('task_status', 't1: running', {
        taskId: 't1',
        status: 'running',
        description: 'do the thing',
      }),
    )
    expect(view?.cls).toBe('is-task_status is-task-running')
    expect(view?.label).toBe('task t1: running')
    expect(view?.detail).toBe('do the thing')
  })

  test('hook announcements name the hook', () => {
    const view = attachmentView(
      att('hook_system_message', 'linted', { hookName: 'post-edit' }),
    )
    expect(view?.label).toBe('post-edit: linted')
  })

  test('untouched types render the generic row with the type name', () => {
    const view = attachmentView(att('brand_new_thing', 'brand_new_thing'))
    expect(view).toEqual({
      cls: 'is-brand_new_thing is-generic',
      label: 'brand_new_thing',
    })
    expect(attachmentGutter('brand_new_thing')).toBe('·')
  })

  test('an item without an attachment payload renders nothing', () => {
    expect(attachmentView(item({ kind: 'attachment' }))).toBeNull()
  })

  test('typed rows have distinct gutters', () => {
    expect(attachmentGutter('edited_text_file')).not.toBe(
      attachmentGutter('task_status'),
    )
  })
})

describe('compactDividerText', () => {
  test('the boundary subtypes read as seams', () => {
    expect(
      compactDividerText(item({ kind: 'system', subtype: 'compact_boundary' })),
    ).toBe('context compacted')
    expect(
      compactDividerText(
        item({ kind: 'system', subtype: 'microcompact_boundary' }),
      ),
    ).toBe('context trimmed')
  })

  test('ordinary system rows are not seams', () => {
    expect(compactDividerText(item({ kind: 'system' }))).toBeNull()
    expect(
      compactDividerText(item({ kind: 'user', subtype: 'compact_boundary' })),
    ).toBeNull()
  })
})

describe('agentIdsByToolUse', () => {
  test('collects the agent id from tool_result items only', () => {
    const map = agentIdsByToolUse([
      item({
        kind: 'tool_result',
        toolUseId: 'tu_1',
        agentId: 'agent-1',
      }),
      item({ kind: 'tool_result', toolUseId: 'tu_2' }),
      item({ kind: 'user', agentId: 'agent-2' }),
    ])
    expect([...map.entries()]).toEqual([['tu_1', 'agent-1']])
  })

  test('an empty transcript has no affordances', () => {
    expect(agentIdsByToolUse([]).size).toBe(0)
  })
})

describe('taskView', () => {
  const base = {
    id: 'task-1',
    kind: 'local_bash',
    description: 'run the tests',
    status: 'running',
    startTime: 1_000,
  }

  test('shells carry command and tail; duration ticks against now', () => {
    const view = taskView(
      { ...base, command: 'bun test', outputTail: '1492 pass' },
      62_000,
    )
    expect(view.marker).toBe('$')
    expect(view.label).toBe('run the tests')
    expect(view.statusCls).toBe('is-running')
    expect(view.duration).toBe('1m 1s')
    expect(view.command).toBe('bun test')
    expect(view.outputTail).toBe('1492 pass')
  })

  test('finished tasks freeze the duration at endTime', () => {
    const view = taskView(
      { ...base, status: 'completed', endTime: 61_000 },
      999_000,
    )
    expect(view.duration).toBe('1m')
  })

  test('a task with no timestamps gets no duration', () => {
    const { startTime: _s, ...noStart } = base
    const view = taskView(noStart, 62_000)
    expect(view.duration).toBeUndefined()
  })

  test('agents get the agent marker and no command row', () => {
    const view = taskView({ ...base, kind: 'local_agent' }, 62_000)
    expect(view.marker).toBe('◈')
    expect(view.command).toBeUndefined()
  })
})
