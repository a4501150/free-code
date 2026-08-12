import { describe, expect, test } from 'bun:test'
import {
  applyHashlineEdits,
  formatAnchoredRegions,
  formatHashline,
  hashLine,
  parseAnchor,
  stripHashlinePrefix,
  type HashlineOp,
} from '../../src/utils/hashline.js'

function lines(...ls: string[]): string {
  return ls.join('\n')
}

describe('hashLine', () => {
  test('is deterministic', () => {
    expect(hashLine('const x = 1')).toBe(hashLine('const x = 1'))
  })

  test('is invariant to leading/trailing whitespace', () => {
    expect(hashLine('  return x')).toBe(hashLine('return x'))
    expect(hashLine('return x\t')).toBe(hashLine('return x'))
  })

  test('produces fixed-width base36', () => {
    for (const s of ['', 'a', 'the quick brown fox', 'x'.repeat(500)]) {
      expect(hashLine(s)).toMatch(/^[0-9a-z]{3}$/)
    }
  })

  test('distinguishes different content', () => {
    expect(hashLine('const x = 1')).not.toBe(hashLine('const x = 2'))
  })
})

describe('formatHashline / stripHashlinePrefix round-trip', () => {
  test('formats each line with a 1-based number and hash', () => {
    const out = formatHashline(lines('alpha', 'beta'), 1)
    const rows = out.split('\n')
    expect(rows[0]).toBe(`1:${hashLine('alpha')}|alpha`)
    expect(rows[1]).toBe(`2:${hashLine('beta')}|beta`)
  })

  test('honors startLine offset', () => {
    const out = formatHashline('gamma', 50)
    expect(out).toBe(`50:${hashLine('gamma')}|gamma`)
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
  })
})

function anchor(content: string, n: number): string {
  return `${n}:${hashLine(content)}`
}

describe('applyHashlineEdits — ops', () => {
  const file = lines('one', 'two', 'three', 'four')

  test('replace single line', () => {
    const edits: HashlineOp[] = [
      { op: 'replace', start: anchor('two', 2), lines: 'TWO' },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('one', 'TWO', 'three', 'four'))
      expect(r.editCount).toBe(1)
    }
  })

  test('replace a multi-line range', () => {
    const edits: HashlineOp[] = [
      {
        op: 'replace',
        start: anchor('two', 2),
        end: anchor('three', 3),
        lines: lines('X', 'Y', 'Z'),
      },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('one', 'X', 'Y', 'Z', 'four'))
  })

  test('insert_after a line', () => {
    const edits: HashlineOp[] = [
      { op: 'insert_after', start: anchor('two', 2), lines: 'inserted' },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.updatedContent).toBe(
        lines('one', 'two', 'inserted', 'three', 'four'),
      )
  })

  test('insert at top with "0"', () => {
    const edits: HashlineOp[] = [
      { op: 'insert_after', start: '0', lines: 'header' },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.updatedContent).toBe(
        lines('header', 'one', 'two', 'three', 'four'),
      )
  })

  test('delete a range', () => {
    const edits: HashlineOp[] = [
      { op: 'delete', start: anchor('two', 2), end: anchor('three', 3) },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('one', 'four'))
  })

  test('multiple ops apply correctly (descending order)', () => {
    const edits: HashlineOp[] = [
      { op: 'replace', start: anchor('one', 1), lines: 'ONE' },
      { op: 'delete', start: anchor('four', 4) },
      { op: 'insert_after', start: anchor('two', 2), lines: 'mid' },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('ONE', 'two', 'mid', 'three'))
  })
})

describe('applyHashlineEdits — guards', () => {
  const file = lines('one', 'two', 'three', 'four')

  test('stale anchor is rejected with fresh anchors', () => {
    const edits: HashlineOp[] = [
      { op: 'replace', start: '2:zzz', lines: 'TWO' },
    ]
    const r = applyHashlineEdits(file, edits, '/tmp/x.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('/tmp/x.ts')
      expect(r.error).toContain(`2:${hashLine('two')}`)
    }
  })

  test('every stale anchor in the batch is reported at once', () => {
    const edits: HashlineOp[] = [
      { op: 'replace', start: '1:zzz', lines: 'ONE' },
      { op: 'replace', start: '3:yyy', lines: 'THREE' },
      { op: 'delete', start: '99:xxx' },
    ]
    const r = applyHashlineEdits(file, edits, '/tmp/x.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('3 anchors no longer match')
      expect(r.error).toContain(`1:${hashLine('one')}`)
      expect(r.error).toContain(`3:${hashLine('three')}`)
      // The file shrank below this anchor, so there is no line to quote.
      expect(r.error).toContain('the file now has 4 line(s)')
    }
  })

  test('a stale anchor is reported even when another edit is well formed', () => {
    const edits: HashlineOp[] = [
      { op: 'replace', start: anchor('one', 1), lines: 'ONE' },
      { op: 'replace', start: '3:yyy', lines: 'THREE' },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Anchor "3:yyy" no longer matches')
  })

  test('out-of-bounds anchor is rejected', () => {
    const edits: HashlineOp[] = [{ op: 'replace', start: '99:abc', lines: 'x' }]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(false)
  })

  test('overlapping ranges are rejected', () => {
    const edits: HashlineOp[] = [
      {
        op: 'replace',
        start: anchor('one', 1),
        end: anchor('three', 3),
        lines: 'X',
      },
      { op: 'delete', start: anchor('two', 2) },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('overlap')
  })

  test('missing lines for replace is rejected', () => {
    const edits = [{ op: 'replace', start: anchor('two', 2) }] as HashlineOp[]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(false)
  })

  test('null-hash anchors skip the staleness check', () => {
    const edits: HashlineOp[] = [{ op: 'replace', start: '2', lines: 'TWO' }]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.updatedContent).toBe(lines('one', 'TWO', 'three', 'four'))
  })
})

describe('applyHashlineEdits — trailing newline', () => {
  test('preserves a trailing newline', () => {
    const file = 'a\nb\n'
    const edits: HashlineOp[] = [
      { op: 'replace', start: anchor('a', 1), lines: 'A' },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe('A\nb\n')
  })

  test('preserves no trailing newline', () => {
    const file = 'a\nb'
    const edits: HashlineOp[] = [
      { op: 'replace', start: anchor('b', 2), lines: 'B' },
    ]
    const r = applyHashlineEdits(file, edits)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe('a\nB')
  })
})

describe('formatAnchoredRegions', () => {
  const file = lines(...Array.from({ length: 100 }, (_, i) => `line ${i + 1}`))

  test('anchors exactly the requested range', () => {
    const out = formatAnchoredRegions(file, [{ start: 2, count: 2 }])
    expect(out).toBe(
      lines(`2:${hashLine('line 2')}|line 2`, `3:${hashLine('line 3')}|line 3`),
    )
  })

  test('separates several regions', () => {
    const out = formatAnchoredRegions(file, [
      { start: 1, count: 1 },
      { start: 50, count: 1 },
    ])
    expect(out).toBe(
      lines(
        `1:${hashLine('line 1')}|line 1`,
        '...',
        `50:${hashLine('line 50')}|line 50`,
      ),
    )
  })

  test('caps the output and says so', () => {
    const out = formatAnchoredRegions(file, [{ start: 1, count: 100 }])
    expect(out.split('\n')).toHaveLength(61)
    expect(out).toContain('more changed lines not shown')
  })

  test('clamps a range that runs past the end of the file', () => {
    const out = formatAnchoredRegions('a\nb', [{ start: 2, count: 5 }])
    expect(out).toBe(`2:${hashLine('b')}|b`)
  })

  test('no regions yields an empty string', () => {
    expect(formatAnchoredRegions(file, [])).toBe('')
  })
})
