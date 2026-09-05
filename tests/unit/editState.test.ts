import { describe, expect, test } from 'bun:test'
import {
  MAX_RESPONSE_EDIT_PATCHES,
  PATCH_CAP_INVALIDATION,
  ResponseEditState,
} from '../../src/utils/editState.js'
import type { FileState } from '../../src/utils/fileStateCache.js'

function fileState(content: string, extra: Partial<FileState> = {}): FileState {
  return { content, timestamp: 1000, ...extra }
}

function fromMap(map: Map<string, FileState>): ResponseEditState {
  const cache = {
    entries: () => map.entries(),
  } as unknown as Parameters<typeof ResponseEditState.fromReadFileState>[0]
  return ResponseEditState.fromReadFileState(cache)
}

describe('ResponseEditState.fromReadFileState', () => {
  test('a whole-file Read (offset 1, no limit) seeds the baseline', () => {
    const editState = fromMap(
      new Map([['/a.ts', fileState('a\nb\nc', { offset: 1 })]]),
    )
    expect(editState.get('/a.ts')?.baselineContent).toBe('a\nb\nc')
    expect(editState.get('/a.ts')?.expectedCurrentContent).toBe('a\nb\nc')
  })

  test('a partial Read does not seed the baseline', () => {
    const editState = fromMap(
      new Map([['/a.ts', fileState('b', { offset: 2, limit: 1 })]]),
    )
    expect(editState.get('/a.ts')?.baselineContent).toBeUndefined()
    expect(editState.get('/a.ts')?.expectedCurrentContent).toBeUndefined()
  })

  test('an Edit/Write entry (no offset) seeds the baseline', () => {
    const editState = fromMap(new Map([['/a.ts', fileState('x')]]))
    expect(editState.get('/a.ts')?.baselineContent).toBe('x')
  })

  test('path keys are normalized', () => {
    const editState = fromMap(new Map([['/a//b/../b.ts', fileState('x')]]))
    expect(editState.get('/a/b.ts')?.baselineContent).toBe('x')
  })
})

describe('beginBaseline / recordEdit', () => {
  test('beginBaseline seeds only once', () => {
    const editState = new ResponseEditState()
    editState.beginBaseline('/a.ts', 'first', fileState('first'))
    editState.beginBaseline('/a.ts', 'second')
    const entry = editState.get('/a.ts')!
    expect(entry.baselineContent).toBe('first')
    expect(entry.expectedCurrentContent).toBe('first')
    expect(entry.snapshot?.content).toBe('first')
  })

  test('recordEdit appends patches and updates expected content', () => {
    const editState = new ResponseEditState()
    editState.beginBaseline('/a.ts', 'a\nb\nc')
    editState.recordEdit('/a.ts', 'A\nb\nc', [
      { oldStart: 1, oldLen: 1, newLen: 1 },
    ])
    const entry = editState.get('/a.ts')!
    expect(entry.expectedCurrentContent).toBe('A\nb\nc')
    expect(entry.patches).toEqual([{ oldStart: 1, oldLen: 1, newLen: 1 }])
  })

  test('recordEdit on an untracked file records nothing', () => {
    const editState = new ResponseEditState()
    editState.recordEdit('/new.ts', 'x', [
      { oldStart: 1, oldLen: 0, newLen: 1 },
    ])
    expect(editState.get('/new.ts')).toBeUndefined()
  })

  test('patch cap invalidates remapping for the file', () => {
    const editState = new ResponseEditState()
    editState.beginBaseline('/a.ts', 'a')
    for (let i = 0; i <= MAX_RESPONSE_EDIT_PATCHES; i++) {
      editState.recordEdit('/a.ts', `a${i}`, [
        { oldStart: 1, oldLen: 0, newLen: 1 },
      ])
    }
    const entry = editState.get('/a.ts')!
    expect(entry.patches).toEqual([])
    expect(entry.baselineContent).toBeUndefined()
    expect(entry.remapUnavailableReason).toBe(PATCH_CAP_INVALIDATION)
  })

  test('recordEdit records nothing once remap is unavailable', () => {
    const editState = new ResponseEditState()
    editState.beginBaseline('/a.ts', 'a')
    editState.invalidate('/a.ts', 'external change')
    editState.recordEdit('/a.ts', 'b', [{ oldStart: 1, oldLen: 1, newLen: 1 }])
    expect(editState.get('/a.ts')?.patches).toEqual([])
    expect(editState.get('/a.ts')?.remapUnavailableReason).toBe(
      'external change',
    )
  })
})

describe('replaceSnapshot / invalidate', () => {
  test('replaceSnapshot restarts from the new content', () => {
    const editState = new ResponseEditState()
    editState.beginBaseline('/a.ts', 'old')
    editState.recordEdit('/a.ts', 'old2', [
      { oldStart: 1, oldLen: 1, newLen: 1 },
    ])
    editState.replaceSnapshot('/a.ts', fileState('brand new', { offset: 1 }))
    const entry = editState.get('/a.ts')!
    expect(entry.baselineContent).toBe('brand new')
    expect(entry.patches).toEqual([])
    expect(entry.remapUnavailableReason).toBeUndefined()
  })

  test('a partial replaceSnapshot keeps remap unmaterialized', () => {
    const editState = new ResponseEditState()
    editState.beginBaseline('/a.ts', 'old')
    editState.replaceSnapshot(
      '/a.ts',
      fileState('slice', { offset: 5, limit: 2 }),
    )
    const entry = editState.get('/a.ts')!
    expect(entry.baselineContent).toBeUndefined()
    expect(entry.expectedCurrentContent).toBeUndefined()
  })

  test('invalidate forces a re-Read', () => {
    const editState = new ResponseEditState()
    editState.beginBaseline('/a.ts', 'a')
    editState.recordEdit('/a.ts', 'b', [{ oldStart: 1, oldLen: 1, newLen: 1 }])
    editState.invalidate('/a.ts', 'File has been modified since read.')
    const entry = editState.get('/a.ts')!
    expect(entry.patches).toEqual([])
    expect(entry.baselineContent).toBeUndefined()
    expect(entry.remapUnavailableReason).toBe(
      'File has been modified since read.',
    )
  })

  test('invalidate on an unknown file is a no-op', () => {
    const editState = new ResponseEditState()
    editState.invalidate('/none.ts', 'why')
    expect(editState.get('/none.ts')).toBeUndefined()
  })
})
