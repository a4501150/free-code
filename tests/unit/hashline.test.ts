import { describe, expect, test } from 'bun:test'
import {
  anchorAt,
  applyHashlineEdits,
  formatAnchoredRegions,
  formatHashline,
  parseAnchor,
  stripHashlinePrefix,
  type HashlineOp,
} from '../../src/utils/hashline.js'

function lines(...ls: string[]): string {
  return ls.join('\n')
}

// The label Read would show for line n of `file` (context-hashed, widened if
// the window repeats), as an Edit anchor.
function anchor(file: string, n: number): string {
  return `${n}:${anchorAt(file, n)}`
}

describe('anchorAt / formatHashline', () => {
  test('labels are deterministic and match the formatted row', () => {
    const file = lines('alpha', 'beta', 'gamma')
    const rows = formatHashline(file, 1).split('\n')
    expect(rows[0]).toBe(`1:${anchorAt(file, 1)}|alpha`)
    expect(rows[1]).toBe(`2:${anchorAt(file, 2)}|beta`)
    expect(rows[2]).toBe(`3:${anchorAt(file, 3)}|gamma`)
  })

  test('is invariant to leading/trailing whitespace on the line', () => {
    expect(anchorAt(lines('  return x'), 1)).toBe(
      anchorAt(lines('return x'), 1),
    )
    expect(anchorAt(lines('return x\t'), 1)).toBe(
      anchorAt(lines('return x'), 1),
    )
  })

  test('repeated lines get distinct labels when their neighbors differ', () => {
    const file = lines('if (a) {', '}', 'if (b) {', '}')
    const labels = new Set(
      formatHashline(file, 1)
        .split('\n')
        .map(r => r.split(':')[1]!.split('|')[0]),
    )
    expect(labels.size).toBe(4)
  })

  test('blank lines get distinct labels when their neighbors differ', () => {
    const file = lines('a', '', 'b', 'c', '', 'd')
    const labels = formatHashline(file, 1)
      .split('\n')
      .map(r => r.split(':')[1]!.split('|')[0])
    expect(new Set(labels).size).toBe(6)
  })

  test('a repeated 3-line window widens to a 4-char "2" label', () => {
    // Lines 3 and 8 sit in identical ±1 windows, so ±1 cannot tell them apart.
    const file = lines(
      'r1',
      'r2',
      'dup',
      'r4',
      'r5',
      'r1',
      'r2',
      'dup',
      'r4',
      'r5',
    )
    const rows = formatHashline(file, 1).split('\n')
    const label3 = rows[2]!.split(':')[1]!.split('|')[0]!
    const label8 = rows[7]!.split(':')[1]!.split('|')[0]!
    expect(label3).toHaveLength(4)
    expect(label3![0]).toBe('2')
    // The ±2 windows differ (line 3 is preceded by 'r2' only within... both sit
    // inside copies of the same 5-line block, so the widened labels collide
    // too — same label on both rows, which the engine reports as ambiguous.
    expect(label8).toBe(label3)
  })

  test('honors startLine offset', () => {
    const file = lines('alpha', 'beta', 'gamma')
    const slice = lines('beta', 'gamma')
    // A slice's edge labels must match the whole file's labels exactly.
    const out = formatHashline(slice, 2, {
      prevLines: ['alpha'],
    })
    const wholeRows = formatHashline(file, 1).split('\n')
    expect(out).toBe(wholeRows.slice(1).join('\n'))
  })

  test('slice context makes edge labels match whole-file labels', () => {
    const file = lines('a', 'b', 'c', 'd', 'e')
    const slice = lines('c', 'd')
    const sliced = formatHashline(slice, 3, {
      prevLines: ['a', 'b'],
      nextLines: ['e'],
    })
    const whole = formatHashline(file, 1).split('\n').slice(2, 4).join('\n')
    expect(sliced).toBe(whole)
  })

  test('empty content yields empty string', () => {
    expect(formatHashline('', 1)).toBe('')
  })

  test('stripHashlinePrefix recovers original content', () => {
    const original = lines('  indented', 'plain', '')
    const formatted = formatHashline(original, 1)
    const recovered = formatted.split('\n').map(stripHashlinePrefix).join('\n')
    expect(recovered).toBe(original)
  })

  test('stripHashlinePrefix passes through non-anchored lines', () => {
    expect(stripHashlinePrefix('no anchor here')).toBe('no anchor here')
  })
})

describe('parseAnchor', () => {
  test('parses LINE:HASH', () => {
    expect(parseAnchor('12:a3f')).toEqual({ line: 12, hash: 'a3f' })
  })

  test('parses a widened label', () => {
    expect(parseAnchor('12:2a3f')).toEqual({ line: 12, hash: '2a3f' })
  })

  test('parses bare line number as null hash', () => {
    expect(parseAnchor('12')).toEqual({ line: 12, hash: null })
  })

  test('parses top-of-file "0"', () => {
    expect(parseAnchor('0')).toEqual({ line: 0, hash: null })
  })

  test('trims surrounding whitespace', () => {
    expect(parseAnchor('  7:abc ')).toEqual({ line: 7, hash: 'abc' })
  })

  test('rejects malformed anchors', () => {
    expect(parseAnchor('')).toBeNull()
    expect(parseAnchor('abc')).toBeNull()
    expect(parseAnchor(':abc')).toBeNull()
    expect(parseAnchor('12:')).toBeNull()
    expect(parseAnchor('12:ab')).toBeNull()
    expect(parseAnchor('12:3abc')).toBeNull()
    expect(parseAnchor('12:abcdef')).toBeNull()
  })
})

describe('applyHashlineEdits — ops', () => {
  const file = lines('one', 'two', 'three', 'four')

  test('replace single line', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 2), lines: 'TWO' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('one', 'TWO', 'three', 'four'))
      expect(r.editCount).toBe(1)
    }
  })

  test('replace a multi-line range', () => {
    const r = applyHashlineEdits(file, [
      {
        op: 'replace',
        start: anchor(file, 2),
        end: anchor(file, 3),
        lines: lines('X', 'Y', 'Z'),
      },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('one', 'X', 'Y', 'Z', 'four'))
  })

  test('insert_after a line', () => {
    const r = applyHashlineEdits(file, [
      { op: 'insert_after', start: anchor(file, 2), lines: 'inserted' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.updatedContent).toBe(
        lines('one', 'two', 'inserted', 'three', 'four'),
      )
  })

  test('insert at top with "0"', () => {
    const r = applyHashlineEdits(file, [
      { op: 'insert_after', start: '0', lines: 'header' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.updatedContent).toBe(
        lines('header', 'one', 'two', 'three', 'four'),
      )
  })

  test('delete a range', () => {
    const r = applyHashlineEdits(file, [
      { op: 'delete', start: anchor(file, 2), end: anchor(file, 3) },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('one', 'four'))
  })

  test('delete an anchor on a blank line', () => {
    const file = lines('a', '', 'b')
    const r = applyHashlineEdits(file, [
      { op: 'delete', start: anchor(file, 2) },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('a', 'b'))
  })

  test('multiple ops apply correctly (descending order)', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 1), lines: 'ONE' },
      { op: 'delete', start: anchor(file, 4) },
      { op: 'insert_after', start: anchor(file, 2), lines: 'mid' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('ONE', 'two', 'mid', 'three'))
  })
})

describe('applyHashlineEdits — guards', () => {
  const file = lines('one', 'two', 'three', 'four')

  test('stale anchor is rejected with fresh anchors', () => {
    const r = applyHashlineEdits(
      file,
      [{ op: 'replace', start: '2:zzz', lines: 'TWO' }],
      '/tmp/x.ts',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('/tmp/x.ts')
      expect(r.error).toContain(anchor(file, 2))
    }
  })

  test('every stale anchor in the batch is reported at once', () => {
    const r = applyHashlineEdits(
      file,
      [
        { op: 'replace', start: '1:zzz', lines: 'ONE' },
        { op: 'replace', start: '3:yyy', lines: 'THREE' },
        { op: 'delete', start: '99:xxx' },
      ],
      '/tmp/x.ts',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('3 anchors no longer match')
      expect(r.error).toContain(anchor(file, 1))
      expect(r.error).toContain(anchor(file, 3))
      // The file shrank below this anchor, so there is no line to quote.
      expect(r.error).toContain('the file now has 4 line(s)')
    }
  })

  test('ambiguous anchor error names the lines that carry the hash', () => {
    // 'dup' at lines 3 and 8 shares a ±2 window with its twin.
    const dupFile = lines(
      'r1',
      'r2',
      'dup',
      'r4',
      'r5',
      'r1',
      'r2',
      'dup',
      'r4',
      'r5',
    )
    const label = anchorAt(dupFile, 3)
    expect(label).toHaveLength(4) // widened by Read, still colliding
    const r = applyHashlineEdits(
      dupFile,
      [{ op: 'replace', start: `5:${label}`, lines: 'X' }],
      '/tmp/x.ts',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('several lines carry that hash')
      expect(r.error).toContain('matching lines: 3, 8')
    }
  })

  test('a stale anchor is reported even when another edit is well formed', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 1), lines: 'ONE' },
      { op: 'replace', start: '3:yyy', lines: 'THREE' },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Anchor "3:yyy" no longer matches')
  })

  test("editing a line makes its neighbor's old anchor stale", () => {
    // Context hashing's cost: line 2's anchor covers line 3, so after line 3
    // is rewritten, line 2's old label no longer names it.
    const now = lines('one', 'two', 'CHANGED', 'four')
    const r = applyHashlineEdits(now, [
      { op: 'replace', start: anchor(file, 2), lines: 'TWO' },
    ])
    expect(r.ok).toBe(false)
  })

  test('out-of-bounds anchor is rejected', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: '99:abc', lines: 'x' },
    ])
    expect(r.ok).toBe(false)
  })

  test('overlapping ranges are rejected', () => {
    const r = applyHashlineEdits(file, [
      {
        op: 'replace',
        start: anchor(file, 1),
        end: anchor(file, 3),
        lines: 'X',
      },
      { op: 'delete', start: anchor(file, 2) },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('overlap')
  })

  test('missing lines for replace is rejected', () => {
    const edits = [{ op: 'replace', start: anchor(file, 2) }] as HashlineOp[]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(false)
  })

  test('null-hash anchors skip the staleness check', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: '2', lines: 'TWO' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.updatedContent).toBe(lines('one', 'TWO', 'three', 'four'))
  })
})

describe('applyHashlineEdits — anchors that moved', () => {
  test('finds a line whose block moved down whole', () => {
    const before = lines('alpha', 'beta', 'gamma', 'delta')
    // Two lines went in above the block since the model read it. The anchor
    // line's neighbors moved with it, so its label still names it.
    const now = lines('alpha', 'NEW1', 'NEW2', 'beta', 'gamma', 'delta')
    const r = applyHashlineEdits(now, [
      { op: 'replace', start: anchor(before, 3), lines: 'GAMMA' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(
        lines('alpha', 'NEW1', 'NEW2', 'beta', 'GAMMA', 'delta'),
      )
      expect(r.driftCount).toBe(1)
    }
  })

  test('finds a line that moved up', () => {
    const before = lines('beta', 'x', 'y', 'gamma', 'delta')
    const now = lines('beta', 'y', 'gamma', 'delta')
    const r = applyHashlineEdits(now, [
      { op: 'replace', start: anchor(before, 4), lines: 'GAMMA' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('beta', 'y', 'GAMMA', 'delta'))
      expect(r.driftCount).toBe(1)
    }
  })

  test('finds a line that moved a long way, since there is no distance limit', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `filler ${i}`)
    const before = lines(...filler, 'the target line')
    const now = lines('top1', 'top2', ...filler, 'the target line')
    const r = applyHashlineEdits(now, [
      { op: 'delete', start: anchor(before, before.split('\n').length) },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('top1', 'top2', ...filler))
  })

  test('prefers an exact line match over a twin elsewhere', () => {
    const file = lines('p', 'dup', 'q', 'r', 'p', 'dup', 'q')
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 6), lines: 'THREE' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(
        lines('p', 'dup', 'q', 'r', 'p', 'THREE', 'q'),
      )
      expect(r.driftCount).toBe(0)
    }
  })

  test('a unique start places an end whose window is generic', () => {
    const before = lines(
      'preamble',
      'function a() {',
      '  body',
      '}',
      'function b() {',
      '  other',
      '}',
    )
    const now = lines('new1', 'new2', 'new3', ...before.split('\n'))
    const r = applyHashlineEdits(now, [
      {
        op: 'replace',
        start: anchor(before, 2),
        end: anchor(before, 4),
        lines: 'REPLACED',
      },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(
        lines(
          'new1',
          'new2',
          'new3',
          'preamble',
          'REPLACED',
          'function b() {',
          '  other',
          '}',
        ),
      )
    }
  })

  test('moves a whole range when both ends shifted alike', () => {
    // The insert keeps each end's neighbors intact — the window moves whole.
    const before = lines('w', 'alpha', 'beta', 'gamma')
    const now = lines('x', 'y', 'w', 'alpha', 'beta', 'gamma')
    const r = applyHashlineEdits(now, [
      { op: 'delete', start: anchor(before, 2), end: anchor(before, 4) },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('x', 'y', 'w'))
      expect(r.driftCount).toBe(2)
    }
  })

  test('refuses a range whose ends shifted differently', () => {
    const before = lines('alpha', 'beta', 'gamma', 'gamma2', 'delta')
    const now = lines(
      'alpha',
      'beta',
      'INS1',
      'INS2',
      'gamma',
      'gamma2',
      'delta',
    )
    const r = applyHashlineEdits(
      now,
      [
        {
          op: 'replace',
          start: anchor(before, 1),
          end: anchor(before, 5),
          lines: 'X',
        },
      ],
      '/tmp/x.ts',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('added or removed inside it')
  })

  test('places an anchor whose line moved after the file shrank above it', () => {
    const before = lines('one', 'two', 'three', 'tail')
    const now = lines('one', 'three', 'tail')
    const r = applyHashlineEdits(now, [
      { op: 'replace', start: anchor(before, 4), lines: 'TAIL' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('one', 'three', 'TAIL'))
  })

  test('counts only the anchors it had to place by content', () => {
    const before = lines('zero', 'one', 'three')
    const now = lines('ZERO', 'zero', 'one', 'three')
    const r = applyHashlineEdits(now, [
      { op: 'replace', start: anchor(before, 2), lines: 'ONE' },
      { op: 'replace', start: anchor(before, 3), lines: 'THREE' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('ZERO', 'zero', 'ONE', 'THREE'))
      expect(r.driftCount).toBe(2)
    }
  })

  test('refuses a hashless anchor past the end of the file', () => {
    // Nothing to search for, so it cannot be placed. Without this it would
    // splice at the clamped end and append in silence.
    const r = applyHashlineEdits(
      lines('one', 'two', 'three', 'four'),
      [{ op: 'replace', start: '99', lines: 'X' }],
      '/tmp/x.ts',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('the file now has 4 line(s)')
  })
})

describe('applyHashlineEdits — trailing newline', () => {
  test('preserves a trailing newline', () => {
    const file = 'a\nb\n'
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 1), lines: 'A' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe('A\nb\n')
  })

  test('preserves no trailing newline', () => {
    const file = 'a\nb'
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 2), lines: 'B' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe('a\nB')
  })
})

describe('formatAnchoredRegions', () => {
  const file = lines(...Array.from({ length: 100 }, (_, i) => `line ${i + 1}`))

  test('anchors exactly the requested range', () => {
    const out = formatAnchoredRegions(file, [{ start: 2, count: 2 }])
    expect(out).toBe(
      lines(anchor(file, 2) + '|line 2', anchor(file, 3) + '|line 3'),
    )
  })

  test('separates several regions', () => {
    const out = formatAnchoredRegions(file, [
      { start: 1, count: 1 },
      { start: 50, count: 1 },
    ])
    expect(out).toBe(
      lines(anchor(file, 1) + '|line 1', '...', anchor(file, 50) + '|line 50'),
    )
  })

  test('caps the output and says so', () => {
    const out = formatAnchoredRegions(file, [{ start: 1, count: 100 }])
    expect(out.split('\n')).toHaveLength(61)
    expect(out).toContain('more changed lines not shown')
  })

  test('clamps a range that runs past the end of the file', () => {
    const file = 'a\nb'
    expect(formatAnchoredRegions(file, [{ start: 2, count: 5 }])).toBe(
      `${anchor(file, 2)}|b`,
    )
  })

  test('no regions yields an empty string', () => {
    expect(formatAnchoredRegions(file, [])).toBe('')
  })
})
