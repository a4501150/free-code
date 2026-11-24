import { beforeEach, describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/headless'
import {
  appendPtyScreenDelta,
  armPtyScreen,
  disarmPtyScreen,
  getPtyScreenSnapshot,
  isPtyScreenCursorVisible,
  ptyPanelColsFor,
  ptyPanelRowsFor,
  resizePtyScreen,
  serializeViewport,
  subscribePtyScreen,
} from '../../src/utils/shell/ptyScreen.js'

const write = (t: Terminal, d: string) => new Promise<void>(r => t.write(d, r))

/** The store coalesces paint notifications on a 32ms timer. */
const settle = () => new Promise(r => setTimeout(r, 60))

describe('pty screen panel dims', () => {
  test('cols subtract margin + borders, rows are half the terminal clamped', () => {
    expect(ptyPanelColsFor(100)).toBe(96)
    expect(ptyPanelRowsFor(24)).toBe(12)
    expect(ptyPanelRowsFor(50)).toBe(16)
    expect(ptyPanelRowsFor(8)).toBe(6)
  })
})

describe('VT viewport serialization', () => {
  test('plain rows trim trailing spaces and mark the cursor cell inverse', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 3 })
    await write(term, 'hello\r\nworld')
    expect(serializeViewport(term)).toEqual([
      'hello',
      // cursor sits on the space after 'world': styled, so it survives trim
      'world\x1b[7m \x1b[0m',
      '',
    ])
    term.dispose()
  })

  test('palette, RGB, background and bold attributes round-trip as SGR', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 2 })
    await write(
      term,
      '\x1b[1;31mRED\x1b[0m \x1b[38;2;1;2;3mX\x1b[0m \x1b[48;5;17mBG\x1b[0m',
    )
    expect(serializeViewport(term)[0]).toBe(
      '\x1b[1;38;5;1mRED\x1b[0m \x1b[38;2;1;2;3mX\x1b[0m \x1b[48;5;17mBG\x1b[0m\x1b[7m \x1b[0m',
    )
    term.dispose()
  })

  test('full-screen apps: alt buffer, absolute addressing, wide chars', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 4 })
    await write(term, '\x1b[?1049h\x1b[2J\x1b[3;2H世x')
    // Row 2 col 2 (index 1): the wide char spans indices 1-2, 'x' at 3.
    expect(serializeViewport(term)).toEqual(['', '', ' 世x\x1b[7m \x1b[0m', ''])
    term.dispose()
  })
})

describe('pty screen store', () => {
  beforeEach(async () => {
    await armPtyScreen(10, 3)
  })

  test('deltas flow into the snapshot and notify subscribers', async () => {
    let notified = 0
    const unsubscribe = subscribePtyScreen(() => {
      notified++
    })
    appendPtyScreenDelta('one\r\n')
    appendPtyScreenDelta('two')
    await settle()
    expect(notified).toBeGreaterThan(0)
    const snap = getPtyScreenSnapshot()
    expect(snap.cols).toBe(10)
    expect(snap.rows).toBe(3)
    expect(snap.lines[0]).toBe('one')
    expect(snap.lines[1]).toBe('two\x1b[7m \x1b[0m')
    unsubscribe()
  })

  test('snapshot identity is stable between changes', async () => {
    appendPtyScreenDelta('x')
    await settle()
    const before = getPtyScreenSnapshot()
    expect(getPtyScreenSnapshot()).toBe(before)
    appendPtyScreenDelta('y')
    await settle()
    expect(getPtyScreenSnapshot()).not.toBe(before)
  })

  test('DECSET 25 hides and shows the cursor block', async () => {
    appendPtyScreenDelta('hi\x1b[?25l')
    await settle()
    expect(isPtyScreenCursorVisible()).toBe(false)
    expect(getPtyScreenSnapshot().lines[0]).toBe('hi')
    // Sequence split across deltas still matches the scan
    appendPtyScreenDelta('\x1b[?2')
    appendPtyScreenDelta('5h')
    await settle()
    expect(isPtyScreenCursorVisible()).toBe(true)
    expect(getPtyScreenSnapshot().lines[0]).toBe('hi\x1b[7m \x1b[0m')
  })

  test('resize reports the new size (reflow truncates without scrollback)', async () => {
    appendPtyScreenDelta('abcdefghij')
    await settle()
    // Cursor sits one past the last column (deferred wrap) — outside the
    // rendered range, so no inverse block on this frame.
    expect(getPtyScreenSnapshot().lines[0]).toBe('abcdefghij')
    resizePtyScreen(5, 3)
    await settle()
    const snap = getPtyScreenSnapshot()
    expect(snap.cols).toBe(5)
    // scrollback 0: the reflowed remainder is dropped, as in a terminal
    // without scrollback; the cursor lands on the last kept cell.
    expect(snap.lines[0]).toBe('abcd\x1b[7me\x1b[0m')
    expect(snap.lines[1]).toBe('')
  })

  test('disarm freezes the snapshot and drops later deltas', async () => {
    appendPtyScreenDelta('before')
    await settle()
    disarmPtyScreen()
    const frozen = getPtyScreenSnapshot()
    appendPtyScreenDelta('after')
    await settle()
    expect(getPtyScreenSnapshot()).toBe(frozen)
    expect(frozen.lines[0]).toBe('before\x1b[7m \x1b[0m')
    // Re-arming starts a clean screen
    await armPtyScreen(10, 3)
    appendPtyScreenDelta('next')
    await settle()
    expect(getPtyScreenSnapshot().lines[0]).toBe('next\x1b[7m \x1b[0m')
    expect(getPtyScreenSnapshot().lines[1]).toBe('')
  })

  test('re-arm resets the visible screen without waiting for a paint tick', async () => {
    appendPtyScreenDelta('stale')
    await settle()
    expect(getPtyScreenSnapshot().lines[0]).toContain('stale')
    // Without the eager cache reset, the next panel's first render would
    // flash the previous command's final frame until the first byte or
    // paint tick arrives.
    await armPtyScreen(10, 3)
    // The fresh screen is empty except the cursor block at home position.
    expect(getPtyScreenSnapshot().lines[0]).toBe('\x1b[7m \x1b[0m')
    expect(getPtyScreenSnapshot().lines[2]).toBe('')
  })

  test('multi-byte characters split across deltas are not corrupted', async () => {
    const bytes = Buffer.from('世')
    appendPtyScreenDelta(bytes.subarray(0, 2))
    appendPtyScreenDelta(bytes.subarray(2))
    await settle()
    expect(getPtyScreenSnapshot().lines[0]).toBe('世\x1b[7m \x1b[0m')
  })

  test('identical frames do not churn snapshot identity', async () => {
    appendPtyScreenDelta('idle')
    await settle()
    const first = getPtyScreenSnapshot()
    // A style-only delta (SGR set, no cell content change) repaints the
    // same frame — subscribers must not get a fresh snapshot object.
    appendPtyScreenDelta('\x1b[31m')
    await settle()
    expect(getPtyScreenSnapshot()).toBe(first)
  })
})
