/**
 * Unit test: DECXCPR cursor-position replies must classify as terminal
 * responses, never as typed input.
 *
 * Regression: probeExternalClear (alt-screen re-entry) queries the cursor
 * with DECXCPR (CSI ? 6 n). xterm, iTerm2, kitty and tmux answer with the
 * three-parameter page-number form (`ESC [ ? row ; col ; page R`). The
 * response regex only matched the two-parameter form, so the reply fell
 * through to parseKeypress, lost its ESC in InputEvent, and `[?27;3;1R`
 * leaked into the prompt as text (the params vary per capture — they are
 * the cursor's row/column/page).
 *
 * Defense in depth: a reply split across reads (lone ESC flushed first)
 * arrives as a bare `[?row;col[;page]R` text token; the orphan path
 * re-synthesizes it into a response instead of leaking it.
 *
 * What this test guards:
 *   - Both the 2-param and 3-param replies emit kind='response' and no key.
 *   - The orphan (ESC-dropped) text form emits kind='response', no input.
 *   - Modified F3 (`ESC [ 1 ; 2 R`) stays a keypress — it is NOT `?`-marked.
 *   - Pasted text shaped like a reply still reaches the prompt.
 */
import { describe, expect, test } from 'bun:test'
import {
  INITIAL_STATE,
  type ParsedInput,
  parseMultipleKeypresses,
} from '../../src/ink/parse-keypress.js'

function feed(input: string): ParsedInput[] {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, input)
  return keys
}

describe('DECXCPR cursor-position response classification', () => {
  test('3-param reply with page number (the bug) is a response, not input', () => {
    const keys = feed('\x1b[?27;3;1R')
    expect(keys).toHaveLength(1)
    expect(keys[0]).toEqual({
      kind: 'response',
      sequence: '\x1b[?27;3;1R',
      response: { type: 'cursorPosition', row: 27, col: 3 },
    })
  })

  test('2-param reply is a response', () => {
    const keys = feed('\x1b[?12;40R')
    expect(keys).toHaveLength(1)
    expect(keys[0]).toEqual({
      kind: 'response',
      sequence: '\x1b[?12;40R',
      response: { type: 'cursorPosition', row: 12, col: 40 },
    })
  })

  test('reply concatenated with typed text splits cleanly', () => {
    const keys = feed('\x1b[?27;3;1Rhello')
    expect(keys).toHaveLength(2)
    expect(keys[0]!.kind).toBe('response')
    expect(keys[1]!.kind).toBe('key')
    expect((keys[1] as { sequence: string }).sequence).toBe('hello')
  })

  test('orphan reply body (lone ESC flushed first) is a response', () => {
    const keys = feed('[?27;3;1R')
    expect(keys).toHaveLength(1)
    expect(keys[0]).toEqual({
      kind: 'response',
      sequence: '[?27;3;1R',
      response: { type: 'cursorPosition', row: 27, col: 3 },
    })
  })

  test('modified F3 (CSI 1;2 R, no ? marker) stays a keypress', () => {
    const keys = feed('\x1b[1;2R')
    expect(keys).toHaveLength(1)
    expect(keys[0]!.kind).toBe('key')
  })

  test('pasted text shaped like a reply reaches the prompt', () => {
    const keys = feed('\x1b[200~[?27;3;1R\x1b[201~')
    expect(keys).toHaveLength(1)
    expect(keys[0]!.kind).toBe('key')
    expect(keys[0]).toMatchObject({ isPasted: true, sequence: '[?27;3;1R' })
  })
})
