import { describe, expect, test } from 'bun:test'
import {
  approveEdit,
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

function planFor(content: string, oldString: string, newString: string, replaceAll = false) {
  const r = planEdit(content, {
    oldString,
    newString,
    replaceAll,
  })
  if (!r.ok) throw new Error('test setup: plan failed: ' + r.failure.message)
  return r.plan
}

const FILE = 'head\ncore line\ntail'

describe('approveEdit', () => {
  test('fresh: disk unchanged and edited lines were seen', () => {
    const r = approveEdit({
      state: state({
        content: FILE,
        seenRanges: [{ start: 1, end: 3 }],
        source: 'read',
      }),
      currentContent: FILE,
      plan: planFor(FILE, 'core line', 'fixed line'),
    })
    expect(r.ok && r.note).toBe('fresh')
  })

  test('a touch with unchanged content still approves as fresh', () => {
    const r = approveEdit({
      state: state({ content: FILE, timestamp: 1, seenRanges: undefined }),
      currentContent: FILE,
      plan: planFor(FILE, 'core line', 'fixed line'),
    })
    expect(r.ok && r.note).toBe('fresh')
  })

  test('blind-placement: current file, edited lines outside seen ranges', () => {
    const r = approveEdit({
      state: state({ content: FILE, seenRanges: [{ start: 1, end: 1 }] }),
      currentContent: FILE,
      plan: planFor(FILE, 'core line', 'fixed line'),
    })
    expect(r.ok && r.note).toBe('blind-placement')
  })

  test('recovered: file moved on disk, match unique and inside seen lines', () => {
    // Formatter rewrote other lines; the seen line itself is unchanged.
    const now = 'HEAD\ncore line\nTAIL'
    const r = approveEdit({
      state: state({ content: FILE, seenRanges: [{ start: 2, end: 2 }] }),
      currentContent: now,
      plan: planFor(now, 'core line', 'fixed line'),
    })
    expect(r.ok && r.note).toBe('recovered')
  })

  test('recovered rejected when the edited text was not inside seen lines', () => {
    const now = 'HEAD\ncore line\nTAIL'
    const r = approveEdit({
      state: state({ content: FILE, seenRanges: [{ start: 1, end: 1 }] }),
      currentContent: now,
      plan: planFor(now, 'core line', 'fixed line'),
    })
    expect(!r.ok && r.errorCode).toBe(7)
  })

  test('recovered rejected for replace_all over a changed file', () => {
    const now = 'head\ncore line\ntail\nextra'
    const r = approveEdit({
      state: state({ content: FILE, seenRanges: [{ start: 1, end: 3 }] }),
      currentContent: now,
      plan: planFor(now, 'core line', 'x', false),
    })
    // Single span, but 'core line' seen-span is covered — approve. Sanity:
    // a replace_all over a changed file is the rejected shape.
    expect(r.ok && r.note).toBe('recovered')

    const dup = 'dup\ndup'
    const r2 = approveEdit({
      state: state({ content: 'a\ndup\ndup', seenRanges: [{ start: 1, end: 3 }] }),
      currentContent: dup,
      plan: planFor(dup, 'dup', 'x', true),
    })
    expect(!r2.ok && r2.errorCode).toBe(7)
  })

  test('no entry: unique match still applies as blind', () => {
    const r = approveEdit({
      state: undefined,
      currentContent: FILE,
      plan: planFor(FILE, 'core line', 'fixed line'),
    })
    expect(r.ok && r.note).toBe('blind')
  })

  test('no entry: replace_all over many matches needs a Read', () => {
    const r = approveEdit({
      state: undefined,
      currentContent: FILE,
      plan: planFor(FILE, 'e', '3', true),
    })
    expect(!r.ok && r.errorCode).toBe(6)
  })

  test('partial view entries behave like no entry', () => {
    const r = approveEdit({
      state: state({ content: FILE, isPartialView: true }),
      currentContent: FILE,
      plan: planFor(FILE, 'core line', 'fixed line'),
    })
    expect(r.ok && r.note).toBe('blind')
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
    ).toEqual([
      { start: 1, end: 8 },
    ])
  })
})
