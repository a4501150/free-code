import { describe, expect, test } from 'bun:test'
import {
  editPlacementNote,
  approveWrite,
  normalizeSeenRanges,
  seenCoversLines,
  wholeFileSeen,
} from '../../src/utils/editApproval.js'
import { planEdit } from '../../src/utils/editMatch.js'
import type { FileState } from '../../src/utils/fileStateCache.js'

function state(over: Partial<FileState>): FileState {
  return {
    content: '',
    timestamp: 0,
    offset: undefined,
    limit: undefined,
    ...over,
  }
}

function planFor(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
) {
  const r = planEdit(content, {
    oldString,
    newString,
    replaceAll,
  })
  if (!r.ok) throw new Error('test setup: plan failed: ' + r.failure.message)
  return r.plan
}

const FILE = 'head\ncore line\ntail'

describe('editPlacementNote', () => {
  test('fresh: disk unchanged and edited lines were seen', () => {
    expect(
      editPlacementNote({
        state: state({
          content: FILE,
          seenRanges: [{ start: 1, end: 3 }],
          source: 'read',
        }),
        currentContent: FILE,
        plan: planFor(FILE, 'core line', 'fixed line'),
      }),
    ).toBe('fresh')
  })

  test('a touch with unchanged content still reads as fresh', () => {
    expect(
      editPlacementNote({
        state: state({ content: FILE, timestamp: 1, seenRanges: undefined }),
        currentContent: FILE,
        plan: planFor(FILE, 'core line', 'fixed line'),
      }),
    ).toBe('fresh')
  })

  test('blind-placement: current file, edited lines outside seen ranges', () => {
    expect(
      editPlacementNote({
        state: state({ content: FILE, seenRanges: [{ start: 1, end: 1 }] }),
        currentContent: FILE,
        plan: planFor(FILE, 'core line', 'fixed line'),
      }),
    ).toBe('blind-placement')
  })

  test('recovered: file moved on disk, match unique and inside seen lines', () => {
    // Formatter rewrote other lines; the seen line itself is unchanged.
    const now = 'HEAD\ncore line\nTAIL'
    expect(
      editPlacementNote({
        state: state({ content: FILE, seenRanges: [{ start: 2, end: 2 }] }),
        currentContent: now,
        plan: planFor(now, 'core line', 'fixed line'),
      }),
    ).toBe('recovered')
  })

  test('unique match outside seen lines reads as blind-modified', () => {
    const now = 'HEAD\ncore line\nTAIL'
    expect(
      editPlacementNote({
        state: state({ content: FILE, seenRanges: [{ start: 1, end: 1 }] }),
        currentContent: now,
        plan: planFor(now, 'core line', 'fixed line'),
      }),
    ).toBe('blind-modified')
  })

  test('replace_all over a changed file reads as blind-modified', () => {
    // The replace_all needle occurs twice in the seen content, so no single
    // seen span can vouch for it — but the note only informs, never gates.
    const dup = 'dup\ndup'
    expect(
      editPlacementNote({
        state: state({
          content: 'a\ndup\ndup',
          seenRanges: [{ start: 1, end: 3 }],
        }),
        currentContent: dup,
        plan: planFor(dup, 'dup', 'x', true),
      }),
    ).toBe('blind-modified')
  })

  test('no sighting reads as blind', () => {
    expect(
      editPlacementNote({
        state: undefined,
        currentContent: FILE,
        plan: planFor(FILE, 'core line', 'fixed line'),
      }),
    ).toBe('blind')

    expect(
      editPlacementNote({
        state: undefined,
        currentContent: FILE,
        plan: planFor(FILE, 'e', '3', true),
      }),
    ).toBe('blind')
  })

  test('partial view behaves like no sighting', () => {
    expect(
      editPlacementNote({
        state: state({ content: FILE, isPartialView: true }),
        currentContent: FILE,
        plan: planFor(FILE, 'core line', 'fixed line'),
      }),
    ).toBe('blind')
  })

  test('ranged Read over an unchanged file keeps replace_all grounded', () => {
    // The flood regression: a ranged Read stores the WHOLE current content,
    // so replace_all on an untouched file reads as placed, not blind.
    const note = editPlacementNote({
      state: state({ content: FILE, seenRanges: [{ start: 2, end: 2 }] }),
      currentContent: FILE,
      plan: planFor(FILE, 'e', '3', true),
    })
    expect(note === 'fresh' || note === 'blind-placement').toBe(true)
  })

  test('slice entries resolve seen lines against contentFirstLine', () => {
    // Entry stores the shown window (lines 2-3 of the file) for a file too
    // large to snapshot. Seen-line math must add the window's start line.
    const now = 'HEAD\ncore line\nTAIL'
    expect(
      editPlacementNote({
        state: state({
          content: 'core line\ntail',
          seenRanges: [{ start: 2, end: 3 }],
          contentFirstLine: 2,
        }),
        currentContent: now,
        plan: planFor(now, 'core line', 'fixed line'),
      }),
    ).toBe('recovered')
  })

  test('unverified (resume-rebuilt) states read as blind', () => {
    const unverified = state({
      content: FILE,
      seenRanges: undefined,
      contentVerified: false,
    })
    expect(
      editPlacementNote({
        state: unverified,
        currentContent: FILE,
        plan: planFor(FILE, 'core line', 'fixed line'),
      }),
    ).toBe('blind')

    expect(
      editPlacementNote({
        state: unverified,
        currentContent: FILE,
        plan: planFor(FILE, 'e', '3', true),
      }),
    ).toBe('blind')
  })
})

describe('approveWrite', () => {
  test('creating a new file is always allowed', () => {
    const r = approveWrite({
      state: undefined,
      fileExists: false,
      currentContent: '',
    })
    expect(r.ok).toBe(true)
  })

  test('whole fresh sighting approves', () => {
    const r = approveWrite({
      state: state({ content: FILE }),
      fileExists: true,
      currentContent: FILE,
    })
    expect(r.ok && r.note).toBe('fresh')
  })

  test('seen ranges covering every line count as whole file', () => {
    const r = approveWrite({
      state: state({ content: FILE, seenRanges: [{ start: 1, end: 3 }] }),
      fileExists: true,
      currentContent: FILE,
    })
    expect(r.ok && r.note).toBe('fresh')
  })

  test('a partial sighting does not license an overwrite', () => {
    const r = approveWrite({
      state: state({ content: 'head', seenRanges: [{ start: 1, end: 1 }] }),
      fileExists: true,
      currentContent: FILE,
    })
    // Partial content does not match disk and the sighting is partial →
    // the model never saw the whole current file.
    expect(!r.ok && r.errorCode).toBe(2)
  })

  test('whole sighting of stale content asks for a re-Read', () => {
    const r = approveWrite({
      state: state({ content: 'old contents', seenRanges: undefined }),
      fileExists: true,
      currentContent: FILE,
    })
    expect(!r.ok && r.errorCode).toBe(3)
    expect(!r.ok && r.message).toContain('modified since read')
  })

  test('no entry at all asks for a Read', () => {
    const r = approveWrite({
      state: undefined,
      fileExists: true,
      currentContent: FILE,
    })
    expect(!r.ok && r.errorCode).toBe(2)
    expect(!r.ok && r.message).toContain('not been read yet')
  })

  test('a ranged sighting of current content asks for a whole-file Read', () => {
    const r = approveWrite({
      state: state({ content: FILE, seenRanges: [{ start: 2, end: 2 }] }),
      fileExists: true,
      currentContent: FILE,
    })
    expect(!r.ok && r.errorCode).toBe(2)
    expect(!r.ok && r.message).toContain('partially read')
    expect(!r.ok && r.message).toContain('Read tool')
  })

  test('unverified (resume-rebuilt) entries never license an overwrite', () => {
    const r = approveWrite({
      state: state({ content: FILE, contentVerified: false }),
      fileExists: true,
      currentContent: FILE,
    })
    expect(!r.ok && r.errorCode).toBe(4)
    expect(!r.ok && r.message).toContain('cannot be verified')
  })
})

describe('helpers', () => {
  test('seenCoversLines', () => {
    expect(seenCoversLines(state({ content: FILE }), 1, 3)).toBe(true)
    expect(
      seenCoversLines(
        state({ content: FILE, seenRanges: [{ start: 2, end: 4 }] }),
        3,
        4,
      ),
    ).toBe(true)
    expect(
      seenCoversLines(
        state({ content: FILE, seenRanges: [{ start: 2, end: 2 }] }),
        2,
        3,
      ),
    ).toBe(false)
    expect(
      seenCoversLines(state({ content: FILE, isPartialView: true }), 1, 1),
    ).toBe(false)
  })

  test('wholeFileSeen requires content equality and total coverage', () => {
    expect(wholeFileSeen(state({ content: FILE }), FILE)).toBe(true)
    expect(
      wholeFileSeen(
        state({ content: FILE, seenRanges: [{ start: 1, end: 2 }] }),
        FILE,
      ),
    ).toBe(false)
    expect(wholeFileSeen(state({ content: 'other' }), FILE)).toBe(false)
    expect(wholeFileSeen(undefined, FILE)).toBe(false)
  })

  test('normalizeSeenRanges merges adjacent and overlapping ranges', () => {
    expect(
      normalizeSeenRanges([
        { start: 5, end: 6 },
        { start: 1, end: 2 },
        { start: 3, end: 4 },
        { start: 6, end: 8 },
      ]),
    ).toEqual([{ start: 1, end: 8 }])
  })
})
