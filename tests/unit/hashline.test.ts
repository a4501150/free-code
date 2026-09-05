import { describe, expect, test } from 'bun:test'
import {
  anchorAt,
  applyHashlineEdits,
  computeHashlineLabels,
  formatAnchoredRegions,
  formatHashline,
  hashLengthForLineCount,
  parseAnchor,
  stripHashlinePrefix,
  type HashlineOp,
} from '../../src/utils/hashline.js'
import { djb2Hash } from '../../src/utils/hash.js'

function lines(...ls: string[]): string {
  return ls.join('\n')
}

// The label Read would show for line n of `file`, as an Edit anchor.
function anchor(file: string, n: number): string {
  return `${n}:${anchorAt(file, n)}`
}

function fp(line: string, lineNo: number): string {
  return (djb2Hash(`${line.trim()}\n${lineNo}`) >>> 0)
    .toString(36)
    .padStart(8, '0')
    .slice(-8)
}

describe('hashLengthForLineCount', () => {
  test('birthday-bound boundaries', () => {
    expect(hashLengthForLineCount(0)).toBe(3)
    expect(hashLengthForLineCount(30)).toBe(3)
    expect(hashLengthForLineCount(31)).toBe(4)
    expect(hashLengthForLineCount(183)).toBe(4)
    expect(hashLengthForLineCount(184)).toBe(5)
    expect(hashLengthForLineCount(1099)).toBe(5)
    expect(hashLengthForLineCount(1100)).toBe(6)
    expect(hashLengthForLineCount(6599)).toBe(6)
  })
})

describe('anchorAt / formatHashline', () => {
  test('labels are deterministic and match the formatted row', () => {
    const file = lines('alpha', 'beta', 'gamma')
    const rows = formatHashline(file).split('\n')
    expect(rows[0]).toBe(`1:${anchorAt(file, 1)}|alpha`)
    expect(rows[1]).toBe(`2:${anchorAt(file, 2)}|beta`)
    expect(rows[2]).toBe(`3:${anchorAt(file, 3)}|gamma`)
  })

  test('labels cover the base length for the file size', () => {
    const file = lines(...Array.from({ length: 40 }, (_, i) => `l${i}`))
    const label = anchorAt(file, 7)
    expect(label).toHaveLength(hashLengthForLineCount(40))
  })

  test('the same line at different line numbers gets a different label', () => {
    const file = lines('dup', 'x', 'dup')
    expect(anchorAt(file, 1)).not.toBe(anchorAt(file, 3))
  })

  test('is invariant to leading/trailing whitespace on the line', () => {
    expect(anchorAt(lines('  return x'), 1)).toBe(
      anchorAt(lines('return x'), 1),
    )
    expect(anchorAt(lines('return x\t'), 1)).toBe(
      anchorAt(lines('return x'), 1),
    )
  })

  test('a slice shows the same labels as the whole file', () => {
    const file = lines(...Array.from({ length: 50 }, (_, i) => `l${i}`))
    const whole = formatHashline(file).split('\n')
    expect(formatHashline(file, { startLine: 10, lineCount: 5 })).toBe(
      whole.slice(9, 14).join('\n'),
    )
    expect(formatHashline(file, { startLine: 48 })).toBe(
      whole.slice(47).join('\n'),
    )
    expect(formatHashline(file, { startLine: 50, lineCount: 9 })).toBe(
      whole.slice(49).join('\n'),
    )
  })

  test('colliding lines widen their labels, never the window', () => {
    // Find content for line 4 whose 3-char truncated fingerprint equals
    // line 1's, deterministically. Lines 2-3 are pads that must not join the
    // collision group.
    const target = fp('x0', 1).slice(-3)
    expect(fp('pad1', 2).slice(-3)).not.toBe(target)
    expect(fp('pad2', 3).slice(-3)).not.toBe(target)
    let k = 0
    let candidate = ''
    for (; ; k++) {
      candidate = `z${k}`
      if (fp(candidate, 4).slice(-3) === target) break
    }
    const file = lines('x0', 'pad1', 'pad2', candidate)
    const rows = formatHashline(file).split('\n')
    const label1 = rows[0]!.split(':')[1]!.split('|')[0]!
    const label4 = rows[3]!.split(':')[1]!.split('|')[0]!
    // Lines 1 and 4 collided at 3 chars, so both widened to length 5.
    expect(label1).toBe(fp('x0', 1).slice(-5))
    expect(label4).toBe(fp(candidate, 4).slice(-5))
    expect(parseAnchor(`1:${label1}`)).not.toBeNull()
  })

  test('empty content yields empty string', () => {
    expect(formatHashline('')).toBe('')
  })

  test('stripHashlinePrefix recovers original content', () => {
    const original = lines('  indented', 'plain', '')
    const formatted = formatHashline(original)
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

  test('parses any label length 3-8', () => {
    expect(parseAnchor('12:2a3f')).toEqual({ line: 12, hash: '2a3f' })
    expect(parseAnchor('12:abcdef')).toEqual({ line: 12, hash: 'abcdef' })
    expect(parseAnchor('12:abcdefab')).toEqual({ line: 12, hash: 'abcdefab' })
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
    expect(parseAnchor('12:abcdefabc')).toBeNull()
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
      expect(r.appliedPatches).toEqual([{ oldStart: 2, oldLen: 1, newLen: 1 }])
      expect(r.lineDelta).toBe(0)
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
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('one', 'X', 'Y', 'Z', 'four'))
      expect(r.appliedPatches).toEqual([{ oldStart: 2, oldLen: 2, newLen: 3 }])
      expect(r.lineDelta).toBe(1)
    }
  })

  test('insert_after a line', () => {
    const r = applyHashlineEdits(file, [
      { op: 'insert_after', start: anchor(file, 2), lines: 'inserted' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(
        lines('one', 'two', 'inserted', 'three', 'four'),
      )
      expect(r.appliedPatches).toEqual([{ oldStart: 3, oldLen: 0, newLen: 1 }])
      expect(r.lineDelta).toBe(1)
    }
  })

  test('insert at top with "0"', () => {
    const r = applyHashlineEdits(file, [
      { op: 'insert_after', start: '0', lines: 'header' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(
        lines('header', 'one', 'two', 'three', 'four'),
      )
      expect(r.appliedPatches).toEqual([{ oldStart: 1, oldLen: 0, newLen: 1 }])
    }
  })

  test('delete a range', () => {
    const r = applyHashlineEdits(file, [
      { op: 'delete', start: anchor(file, 2), end: anchor(file, 3) },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('one', 'four'))
      expect(r.appliedPatches).toEqual([{ oldStart: 2, oldLen: 2, newLen: 0 }])
      expect(r.lineDelta).toBe(-2)
    }
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
    if (r.ok) {
      expect(r.updatedContent).toBe(lines('ONE', 'two', 'mid', 'three'))
      // Chronological order is splice-coordinate order, ascending.
      expect(r.appliedPatches).toEqual([
        { oldStart: 1, oldLen: 1, newLen: 1 },
        { oldStart: 3, oldLen: 0, newLen: 1 },
        { oldStart: 4, oldLen: 1, newLen: 0 },
      ])
    }
  })

  test('contiguous replacements coalesce into one patch', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 1), lines: 'ONE' },
      { op: 'replace', start: anchor(file, 2), lines: 'TWO' },
    ])
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.appliedPatches).toEqual([{ oldStart: 1, oldLen: 2, newLen: 2 }])
  })

  test('editing a line does not stale its neighbor (no window hashing)', () => {
    // The old engine's core complaint: line 3's rewrite changed line 2's
    // label because the window covered it. Content+line hashing has no
    // windows, so an untouched line keeps its anchor forever.
    const now = lines('one', 'two', 'CHANGED', 'four')
    const r = applyHashlineEdits(now, [
      { op: 'replace', start: anchor(file, 2), lines: 'TWO' },
    ])
    expect(r.ok).toBe(true)
  })
})

describe('applyHashlineEdits — guards', () => {
  const file = lines('one', 'two', 'three', 'four')

  test('stale anchor is rejected with fresh anchors', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: '2:zzz', lines: 'TWO' },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Anchor validation failed')
      expect(r.error).toContain(anchor(file, 2))
      expect(r.error).toContain('Current content near the affected lines')
      expect(r.error).toContain('Re-read the file or use the anchors above.')
    }
  })

  test('every stale anchor in the batch is reported at once', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: '1:zzz', lines: 'ONE' },
      { op: 'replace', start: '3:yyy', lines: 'THREE' },
      { op: 'delete', start: '99:xxx' },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain(`${anchor(file, 1)}|one`)
      expect(r.error).toContain(`${anchor(file, 3)}|three`)
      expect(r.error).toContain('outside the current file (4 line(s))')
    }
  })

  test('a mismatching anchor is reported even when another edit is well formed', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: anchor(file, 1), lines: 'ONE' },
      { op: 'replace', start: '3:yyy', lines: 'THREE' },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Anchor validation failed')
  })

  test('out-of-bounds anchor is rejected', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: '99:abc', lines: 'x' },
    ])
    expect(r.ok).toBe(false)
  })

  test('positive anchors must carry a hash', () => {
    const r = applyHashlineEdits(file, [
      { op: 'replace', start: '2', lines: 'TWO' },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('only "0" may omit the hash')
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
})

describe('applyHashlineEdits — same-response remap', () => {
  const before = lines('one', 'two', 'three', 'four')

  test('an anchor below an insertion maps through the patch', () => {
    // Edit #1 of this response inserted a line at the top; Edit #2 still
    // holds anchors from the message-start snapshot.
    const now = lines('ZERO', 'one', 'two', 'three', 'four')
    const r = applyHashlineEdits(
      now,
      [{ op: 'replace', start: anchor(before, 3), lines: 'THREE' }],
      {
        baselineContent: before,
        patches: [{ oldStart: 1, oldLen: 0, newLen: 1 }],
      },
    )
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.updatedContent).toBe(
        lines('ZERO', 'one', 'two', 'THREE', 'four'),
      )
  })

  test('an anchor below a deletion maps up', () => {
    const now = lines('two', 'three', 'four')
    const r = applyHashlineEdits(
      now,
      [{ op: 'replace', start: anchor(before, 4), lines: 'FOUR' }],
      {
        baselineContent: before,
        patches: [{ oldStart: 1, oldLen: 1, newLen: 0 }],
      },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('two', 'three', 'FOUR'))
  })

  test('an anchor whose line was rewritten by an earlier patch is rejected', () => {
    const now = lines('one', 'TWO_A', 'TWO_B', 'three', 'four')
    const r = applyHashlineEdits(
      now,
      [{ op: 'replace', start: anchor(before, 2), lines: 'TWO' }],
      {
        baselineContent: before,
        patches: [{ oldStart: 2, oldLen: 1, newLen: 2 }],
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toContain('rewritten by an earlier edit in this message')
  })

  test('a range maps when an insertion fell outside it', () => {
    const now = lines('ZERO', 'one', 'two', 'three', 'four')
    const r = applyHashlineEdits(
      now,
      [
        {
          op: 'delete',
          start: anchor(before, 2),
          end: anchor(before, 3),
        },
      ],
      {
        baselineContent: before,
        patches: [{ oldStart: 1, oldLen: 0, newLen: 1 }],
      },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.updatedContent).toBe(lines('ZERO', 'one', 'four'))
  })

  test('a range with a patch inside it is rejected', () => {
    const base = lines('a1', 'a2', 'a3', 'a4', 'a5')
    const now = lines('a1', 'a2', 'INS', 'a3', 'a4', 'a5')
    const r = applyHashlineEdits(
      now,
      [
        {
          op: 'replace',
          start: anchor(base, 1),
          end: anchor(base, 5),
          lines: 'X',
        },
      ],
      {
        baselineContent: base,
        patches: [{ oldStart: 3, oldLen: 0, newLen: 1 }],
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toContain('changed by an earlier edit in this message')
  })

  test('a fully consumed range is rejected as consumed', () => {
    const now = lines('REWRITTEN')
    const r = applyHashlineEdits(
      now,
      [
        {
          op: 'delete',
          start: anchor(before, 1),
          end: anchor(before, 4),
        },
      ],
      {
        baselineContent: before,
        patches: [{ oldStart: 1, oldLen: 4, newLen: 1 }],
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('rewritten by an earlier edit')
  })

  test('an anchor that does not match the baseline is rejected', () => {
    const r = applyHashlineEdits(
      before,
      [{ op: 'replace', start: '2:zzz', lines: 'TWO' }],
      { baselineContent: before, patches: [] },
    )
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toContain(
        'does not match the snapshot used for this response',
      )
  })

  test('a mapped line whose content changed externally is rejected', () => {
    // The patch says line 4 moved to 5, but line 5 no longer holds it.
    const now = lines('ZERO', 'one', 'two', 'three', 'DIFFERENT')
    const r = applyHashlineEdits(
      now,
      [{ op: 'replace', start: anchor(before, 4), lines: 'FOUR' }],
      {
        baselineContent: before,
        patches: [{ oldStart: 1, oldLen: 0, newLen: 1 }],
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('content differs now')
  })

  test('exact anchors still resolve when remapping is unavailable', () => {
    const r = applyHashlineEdits(
      lines('one', 'TWO', 'three', 'four'),
      [{ op: 'replace', start: anchor(before, 3), lines: 'THREE' }],
      {
        baselineContent: before,
        remapUnavailableReason: 'too many edits',
      },
    )
    expect(r.ok).toBe(true)
  })

  test('a shifted anchor fails with the invalidation reason when remap is unavailable', () => {
    const now = lines('ZERO', 'one', 'two', 'three', 'four')
    const r = applyHashlineEdits(
      now,
      [{ op: 'replace', start: anchor(before, 3), lines: 'THREE' }],
      {
        baselineContent: before,
        patches: [{ oldStart: 1, oldLen: 0, newLen: 1 }],
        remapUnavailableReason: 'Too many earlier edits in this response',
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Too many earlier edits in this response')
      expect(r.error).toContain('no snapshot is available to remap it')
    }
  })

  test('without a baseline, a shifted anchor reports no-baseline', () => {
    // Cross-message anchor below a structural edit: no remap story exists.
    const now = lines('ZERO', 'one', 'two', 'three', 'four')
    const r = applyHashlineEdits(
      now,
      [{ op: 'replace', start: anchor(before, 3), lines: 'THREE' }],
      { filePath: '/tmp/x.ts' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('no snapshot is available to remap it')
  })

  test('baseline equal to current content needs no remap machinery', () => {
    const r = applyHashlineEdits(
      before,
      [{ op: 'replace', start: anchor(before, 2), lines: 'TWO' }],
      { baselineContent: before, patches: [] },
    )
    expect(r.ok).toBe(true)
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

describe('computeHashlineLabels', () => {
  test('empty content has no labels', () => {
    const set = computeHashlineLabels('')
    expect(set.labels).toEqual([])
    expect(set.length).toBe(3)
  })

  test('CRLF and LF content label identically (hash trims)', () => {
    const lf = lines('a', 'b', 'c')
    const crlf = 'a\r\nb\r\nc'
    expect(computeHashlineLabels(crlf).labels).toEqual(
      computeHashlineLabels(lf).labels,
    )
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
