import { describe, expect, test } from 'bun:test'
import {
  composerBusy,
  composerPlaceholder,
  queueEditBody,
  queueRemoveBody,
  queueRows,
  rpcBody,
  slashSuggestions,
  submitIntent,
} from '../../src/webui/client/composerViews.js'
import type {
  WireCatalog,
  WirePendingCommand,
  WireSessionMeta,
} from '../../src/session/wire.js'

const meta = (over: Partial<WireSessionMeta> = {}): WireSessionMeta =>
  ({
    sessionId: 's',
    sessionEpoch: 0,
    cwd: '/w',
    startedAt: 1,
    state: 'idle',
    ...over,
  }) as WireSessionMeta

const cmd = (
  name: string,
  description?: string,
  argHint?: string,
): WireCatalog['commands'][number] => ({ name, description, argHint })

describe('slashSuggestions', () => {
  const commands = [
    cmd('compact', 'compress the context'),
    cmd('config-mcp', 'edit mcp config', '<server>'),
    cmd('context'),
    cmd('/resume', 'pick a session', '<id>'),
  ]

  test('matches rank by length then name, so /co puts /compact first', () => {
    const items = slashSuggestions(commands, '/co')
    expect(items.map(i => i.value)).toEqual([
      '/compact',
      '/context',
      '/config-mcp',
    ])
  })

  test('carries descriptions and arg hints through', () => {
    const items = slashSuggestions(commands, '/config')
    expect(items[0]).toEqual({
      value: '/config-mcp',
      detail: 'edit mcp config',
      hint: '<server>',
    })
  })

  test('catalog names without a leading slash are shown with one', () => {
    expect(slashSuggestions(commands, '/res')[0]!.value).toBe('/resume')
  })

  test('non-slash tokens and misses come back empty', () => {
    expect(slashSuggestions(commands, 'conf')).toEqual([])
    expect(slashSuggestions(commands, '@src')).toEqual([])
    expect(slashSuggestions(commands, '/zzz')).toEqual([])
  })

  test('the bare slash lists everything, capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`/c${i}`))
    expect(slashSuggestions(many, '/').length).toBe(12)
  })
})

describe('submitIntent', () => {
  const base = {
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    busy: false,
  }

  test('plain Enter queues', () => {
    expect(submitIntent(base)).toBe('next')
    expect(submitIntent({ ...base, busy: true })).toBe('next')
  })

  test('Shift+Enter interrupts a running turn and is a newline otherwise', () => {
    expect(submitIntent({ ...base, shiftKey: true, busy: true })).toBe(
      'interrupt',
    )
    expect(submitIntent({ ...base, shiftKey: true, busy: false })).toBe(
      'newline',
    )
  })

  test('Alt+Enter is always a newline', () => {
    expect(submitIntent({ ...base, altKey: true, busy: true })).toBe('newline')
  })

  test('cmd/ctrl Enter belong to the browser', () => {
    expect(submitIntent({ ...base, metaKey: true })).toBe('none')
    expect(submitIntent({ ...base, ctrlKey: true })).toBe('none')
  })

  test('other keys are no intent', () => {
    expect(submitIntent({ ...base, key: 'a' })).toBe('none')
  })
})

describe('composer busy affordance', () => {
  test('only a running session is busy; compacting runs under running', () => {
    expect(composerBusy(null)).toBe(false)
    expect(composerBusy(meta())).toBe(false)
    expect(
      composerBusy(meta({ state: 'running', activity: 'compacting' })),
    ).toBe(true)
  })

  test('the placeholder teaches the interrupt while busy', () => {
    expect(composerPlaceholder(false)).toContain('/')
    expect(composerPlaceholder(true)).toContain('Shift+Enter')
  })
})

describe('queue rows and rpc bodies', () => {
  const row = (
    id: string,
    text: string,
    isMeta?: boolean,
  ): WirePendingCommand => ({ id, text, isMeta })

  test("meta commands are the session's own, not shown", () => {
    const rows = queueRows([
      row('a', 'fix the test', false),
      row('b', '<system-reminder>', true),
    ])
    expect(rows.map(r => r.id)).toEqual(['a'])
  })

  test('edit and remove bodies address the row by id', () => {
    expect(queueEditBody('a', 'new text')).toEqual({
      kind: 'rpc',
      method: 'queue_edit',
      params: { commandId: 'a', text: 'new text' },
    })
    expect(queueRemoveBody('a')).toEqual({
      kind: 'rpc',
      method: 'queue_remove',
      params: { commandId: 'a' },
    })
  })

  test('lifecycle bodies', () => {
    expect(rpcBody('compact')).toEqual({ kind: 'rpc', method: 'compact' })
    expect(rpcBody('clear')).toEqual({ kind: 'rpc', method: 'clear' })
  })
})
