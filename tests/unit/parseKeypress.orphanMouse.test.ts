/**
 * Unit test: SGR mouse-event leakage into the prompt during scrolling.
 *
 * Regression: a wheel-scroll event (`\x1b[<65;col;rowM`) split across stdin
 * chunks (slow SSH / tmux backbuffer drain) AND a flush-timer fire could
 * leak its bytes into the prompt as text. Specifically:
 *   1) Chunk 1 `\x1b[<65;1` arrives — tokenizer holds it as mid-CSI buffer.
 *   2) Flush timer fires at 50ms before the continuation arrives (gap > 50ms).
 *   3) Tokenizer flushes the partial as a SEQUENCE; parseKeypress can't
 *      classify it (no terminator). Returns key with name='', sequence=
 *      `\x1b[<65;1` → InputEvent strips ESC and emits input=`[<65;1`.
 *   4) Chunk 2 `15;25M` arrives as text — also unclassifiable; emits
 *      input=`15;25M`.
 *   5) Concatenated in the prompt: `[<65;115;25M`.
 *
 * Fix is two-fold (defense in depth):
 *   - App.computeFlushTimeout uses a longer timeout (PASTE_TIMEOUT) for
 *     mid-CSI/OSC/DCS/APC partial buffers so the continuation has time
 *     to arrive (timing-only, exercised in the e2e harness).
 *   - InputEvent.parseKey suppresses partial CSI fragments and tail-text
 *     fragments when the keypress has no name and isn't pasted (this file).
 *
 * What this test guards:
 *   - The bug scenario does not leak.
 *   - Legitimate wheel events still classify as wheelup/wheeldown.
 *   - Pasted content matching the same regex is NOT suppressed (gated on
 *     keypress.isPasted) — pasting a terminal log containing `[<65;115;25M`
 *     must reach the prompt.
 *   - Typed input around the regex shape is preserved.
 *   - Other escape sequences (Escape, arrow keys, Alt+Space) still work.
 */
import { describe, expect, test } from 'bun:test'
import { InputEvent } from '../../src/ink/events/input-event.js'
import {
  INITIAL_STATE,
  type KeyParseState,
  parseMultipleKeypresses,
} from '../../src/ink/parse-keypress.js'

type Emitted = {
  input: string
  name: string | undefined
  isPasted: boolean
  wheelUp: boolean
  wheelDown: boolean
  escape: boolean
}

function feed(
  state: KeyParseState,
  input: string | null,
): { state: KeyParseState; emitted: Emitted[] } {
  const [keys, newState] = parseMultipleKeypresses(state, input)
  const emitted: Emitted[] = []
  for (const k of keys) {
    if (k.kind !== 'key') continue
    const ev = new InputEvent(k)
    emitted.push({
      input: ev.input,
      name: k.name,
      isPasted: k.isPasted,
      wheelUp: ev.key.wheelUp,
      wheelDown: ev.key.wheelDown,
      escape: ev.key.escape,
    })
  }
  return { state: newState, emitted }
}

describe('SGR mouse orphan suppression', () => {
  test('mid-CSI flush followed by tail does not leak (the bug)', () => {
    let s = INITIAL_STATE
    // Chunk 1: partial CSI buffered (state=csi, no terminator)
    let r = feed(s, '\x1b[<65;1')
    s = r.state
    expect(r.emitted).toEqual([])

    // Flush fires before continuation arrives (slow SSH gap > timeout)
    r = feed(s, null)
    s = r.state
    expect(r.emitted).toHaveLength(1)
    // Partial flushed as sequence with no name; suppressed in InputEvent
    expect(r.emitted[0]!.input).toBe('')
    expect(r.emitted[0]!.name).toBe('')

    // Chunk 2: tail-text continuation arrives later
    r = feed(s, '15;25M')
    s = r.state
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.input).toBe('')
    expect(r.emitted[0]!.name).toBe('')
  })

  test('full wheel event classifies as wheeldown', () => {
    const r = feed(INITIAL_STATE, '\x1b[<65;115;25M')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.name).toBe('wheeldown')
    expect(r.emitted[0]!.wheelDown).toBe(true)
    expect(r.emitted[0]!.input).toBe('')
  })

  test('full wheel event classifies as wheelup', () => {
    const r = feed(INITIAL_STATE, '\x1b[<64;115;25M')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.name).toBe('wheelup')
    expect(r.emitted[0]!.wheelUp).toBe(true)
    expect(r.emitted[0]!.input).toBe('')
  })

  test('orphan ESC-less wheel event (text-token path) classifies as wheeldown', () => {
    // Lone ESC flushed first (e.g. heavy-render race), continuation as text
    const r = feed(INITIAL_STATE, '[<65;115;25M')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.name).toBe('wheeldown')
    expect(r.emitted[0]!.input).toBe('')
  })

  test('coalesced text-token orphans both classify as wheel events', () => {
    const r = feed(INITIAL_STATE, '[<65;1;1M[<65;2;2M')
    expect(r.emitted).toHaveLength(2)
    expect(r.emitted[0]!.name).toBe('wheeldown')
    expect(r.emitted[1]!.name).toBe('wheeldown')
    expect(r.emitted[0]!.input).toBe('')
    expect(r.emitted[1]!.input).toBe('')
  })
})

describe('paste content matching the orphan regex is preserved', () => {
  test('paste of `[<65;115;25M` reaches the prompt', () => {
    const r = feed(INITIAL_STATE, '\x1b[200~[<65;115;25M\x1b[201~')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.isPasted).toBe(true)
    // Suppression must NOT apply to pasted content (gated on !isPasted)
    expect(r.emitted[0]!.input).toBe('[<65;115;25M')
  })

  test('paste of `15;25M` (tail-shape) reaches the prompt', () => {
    const r = feed(INITIAL_STATE, '\x1b[200~15;25M\x1b[201~')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.isPasted).toBe(true)
    expect(r.emitted[0]!.input).toBe('15;25M')
  })

  test('paste of `[<65;1` (partial-shape) reaches the prompt', () => {
    const r = feed(INITIAL_STATE, '\x1b[200~[<65;1\x1b[201~')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.isPasted).toBe(true)
    expect(r.emitted[0]!.input).toBe('[<65;1')
  })

  test('paste of normal content unaffected', () => {
    const r = feed(INITIAL_STATE, '\x1b[200~hello world\x1b[201~')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.isPasted).toBe(true)
    expect(r.emitted[0]!.input).toBe('hello world')
  })
})

describe('typed input is not suppressed', () => {
  test('user types `[hello]`', () => {
    const r = feed(INITIAL_STATE, '[hello]')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.input).toBe('[hello]')
  })

  test('user types `abc`', () => {
    const r = feed(INITIAL_STATE, 'abc')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.input).toBe('abc')
  })

  test('user types `123`', () => {
    const r = feed(INITIAL_STATE, '123')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.input).toBe('123')
  })
})

describe('other escape sequences continue to work', () => {
  test('lone ESC across flush emits Escape', () => {
    let s = INITIAL_STATE
    let r = feed(s, '\x1b')
    s = r.state
    expect(r.emitted).toEqual([])
    r = feed(s, null)
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.escape).toBe(true)
    expect(r.emitted[0]!.name).toBe('escape')
  })

  test('Up arrow `\\x1b[A` classifies as up', () => {
    const r = feed(INITIAL_STATE, '\x1b[A')
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.name).toBe('up')
    expect(r.emitted[0]!.input).toBe('')
  })

  test('Alt+Space across flush emits space with meta', () => {
    let s = INITIAL_STATE
    let r = feed(s, '\x1b ')
    s = r.state
    expect(r.emitted).toEqual([])
    r = feed(s, null)
    expect(r.emitted).toHaveLength(1)
    expect(r.emitted[0]!.name).toBe('space')
    expect(r.emitted[0]!.input).toBe(' ')
  })
})
