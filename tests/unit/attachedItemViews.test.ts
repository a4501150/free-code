import { describe, expect, test } from 'bun:test'
import type { WireItem, WireStreamDraft } from '../../src/session/wire.js'
import { PAUSE_ICON } from '../../src/constants/figures.js'
import {
  bottomBarParts,
  draftView,
  modeLabel,
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

describe('modeLabel', () => {
  test('the default mode says manual mode on, dim (no color)', () => {
    expect(modeLabel('default')).toEqual({
      text: `${PAUSE_ICON} manual mode on`,
    })
    expect(modeLabel(undefined).text).toBe(`${PAUSE_ICON} manual mode on`)
  })
  test('a mode with its own symbol and title says what the classic footer says', () => {
    expect(modeLabel('plan')).toEqual({
      text: `${PAUSE_ICON} plan mode on`,
      color: 'planMode',
    })
    expect(modeLabel('acceptEdits')).toEqual({
      text: '⏵⏵ accept edits on',
      color: 'autoAccept',
    })
  })
})

describe('bottomBarParts', () => {
  test('the idle hint is the classic one', () => {
    expect(bottomBarParts({ running: false }).left).toBe('? for shortcuts')
  })

  test('a running turn asks for esc, a tray asks for an answer', () => {
    expect(bottomBarParts({ running: true }).left).toBe('esc to interrupt')
    expect(bottomBarParts({ running: true, waitingForUser: true }).left).toBe(
      'answer above to continue',
    )
  })
})
