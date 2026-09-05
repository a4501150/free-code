import { describe, expect, test } from 'bun:test'
import { ResponseEditState } from '../../src/utils/editState.js'

describe('ResponseEditState', () => {
  test('an edited file is flagged until cleared', () => {
    const state = new ResponseEditState()
    expect(state.isEdited('/a/b.ts')).toBe(false)
    state.markEdited('/a/b.ts')
    expect(state.isEdited('/a/b.ts')).toBe(true)
    state.clearEdited('/a/b.ts')
    expect(state.isEdited('/a/b.ts')).toBe(false)
  })

  test('path keys are normalized', () => {
    const state = new ResponseEditState()
    state.markEdited('/a/./b.ts')
    expect(state.isEdited('/a/b.ts')).toBe(true)
    state.clearEdited('/a/b.ts')
    expect(state.isEdited('/a/./b.ts')).toBe(false)
  })

  test('clearing an unedited file is a no-op', () => {
    const state = new ResponseEditState()
    state.clearEdited('/a/b.ts')
    expect(state.isEdited('/a/b.ts')).toBe(false)
  })

  test('files are tracked independently', () => {
    const state = new ResponseEditState()
    state.markEdited('/a/b.ts')
    state.markEdited('/a/c.ts')
    state.clearEdited('/a/b.ts')
    expect(state.isEdited('/a/b.ts')).toBe(false)
    expect(state.isEdited('/a/c.ts')).toBe(true)
  })
})
