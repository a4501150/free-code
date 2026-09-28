import { describe, expect, test } from 'bun:test'
import type { WireItem, WireStreamDraft } from '../../src/session/wire.js'
import {
  activityLabel,
  draftView,
  formatDuration,
  toolRowView,
  userRowView,
} from '../../src/screens/attached/itemViews.js'
import {
  foldText,
  summarizeToolInput,
} from '../../src/screens/attached/itemViews.js'

const item = (over: Partial<WireItem>): WireItem => ({
  id: 'i1',
  kind: 'user',
  rev: 'r1',
  timestamp: '2026-09-28T00:00:00Z',
  ...over,
})

describe('userRowView', () => {
  test('a plain prompt is visible and carries its text', () => {
    expect(userRowView(item({ kind: 'user', text: 'hello' }))).toEqual({
      visible: true,
      text: 'hello',
    })
  })
  test('a meta user row is hidden', () => {
    expect(
      userRowView(item({ kind: 'user', text: 'x', isMeta: true })),
    ).toEqual({ visible: false, text: 'x' })
  })
  test('an image row shows metadata, never bytes', () => {
    const row = userRowView(
      item({ kind: 'user', image: { mediaType: 'image/png', bytes: 1234 } }),
    )
    expect(row.visible).toBe(true)
    expect(row.imageLabel).toContain('image/png')
    expect(row.imageLabel).toContain('1234')
  })
})

describe('toolRowView', () => {
  const bash = item({
    kind: 'tool_use',
    toolName: 'Bash',
    toolUseId: 't1',
    toolInput: { command: 'ls -la' },
  })
  const result = item({ kind: 'tool_result', toolUseId: 't1', text: 'ok' })

  test('a completed call is not running and summarizes its command', () => {
    const row = toolRowView(bash, result, new Set(['t1']))
    expect(row.name).toBe('Bash')
    expect(row.summary).toBe('ls -la')
    expect(row.running).toBe(false)
  })
  test('without a result, an in-flight id marks it running', () => {
    expect(toolRowView(bash, undefined, new Set(['t1'])).running).toBe(true)
  })
  test('an unknown tool degrades to the argument count', () => {
    const row = toolRowView(
      item({
        kind: 'tool_use',
        toolName: 'mcp__x__do',
        toolUseId: 't2',
        toolInput: { a: 1, b: 2 },
      }),
      undefined,
      new Set(),
    )
    expect(row.summary).toBe('2 arguments')
    expect(row.running).toBe(false)
  })
})

describe('summarizeToolInput', () => {
  test('file tools show the path', () => {
    expect(
      summarizeToolInput(
        item({
          kind: 'tool_use',
          toolName: 'Edit',
          toolInput: { file_path: '/p/x.ts' },
        }),
      ),
    ).toBe('/p/x.ts')
  })
  test('no input summarizes to nothing', () => {
    expect(
      summarizeToolInput(
        item({ kind: 'tool_use', toolName: 'Bash', toolInput: {} }),
      ),
    ).toBe('')
  })
})

describe('foldText', () => {
  test('short text passes through unfolded', () => {
    expect(foldText('a\nb', 4)).toEqual({ text: 'a\nb', hidden: 0 })
  })
  test('long text keeps the head and counts what fell off', () => {
    const fold = foldText('1\n2\n3\n4\n5\n6', 4)
    expect(fold.text).toBe('1\n2\n3\n4')
    expect(fold.hidden).toBe(2)
  })
  test('empty is empty', () => {
    expect(foldText(undefined, 4)).toEqual({ text: '', hidden: 0 })
  })
})

describe('draftView', () => {
  const draft = (over: Partial<WireStreamDraft>): WireStreamDraft => ({
    tools: [],
    ...over,
  })

  test('null draft renders nothing', () => {
    expect(draftView(null)).toBeNull()
  })
  test('an empty draft renders nothing', () => {
    expect(draftView(draft({}))).toBeNull()
  })
  test('text passes whole, thinking keeps its tail', () => {
    const view = draftView(
      draft({
        text: 'writing now',
        thinking: 'a\nb\nc\nd\ne',
      }),
    )
    expect(view?.text).toBe('writing now')
    expect(view?.thinking).toBe('…\nc\nd\ne')
  })
  test('tool partials keep their tail where the JSON streams', () => {
    const long = 'x'.repeat(300)
    const view = draftView(
      draft({ tools: [{ toolName: 'Write', partialJson: long }] }),
    )
    expect(view?.tools[0]?.toolName).toBe('Write')
    expect(view?.tools[0]?.partialJson.startsWith('…')).toBe(true)
    expect(view!.tools[0]!.partialJson.length).toBeLessThanOrEqual(160)
  })
})

describe('activityLabel', () => {
  test('compacting names itself', () => {
    expect(activityLabel('compacting', 'running')).toBe('compacting context…')
  })
  test('phases name their spinner words', () => {
    expect(activityLabel('thinking', 'running')).toBe('thinking…')
    expect(activityLabel(undefined, 'running')).toBe('working…')
  })
  test('idle is silent, requires_action waits', () => {
    expect(activityLabel(undefined, 'idle')).toBe('')
    expect(activityLabel(undefined, 'requires_action')).toBe('waiting')
  })
})

describe('formatDuration', () => {
  test('seconds, minutes, hours', () => {
    expect(formatDuration(9_400)).toBe('9s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(125_000)).toBe('2m 5s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
  })
})
