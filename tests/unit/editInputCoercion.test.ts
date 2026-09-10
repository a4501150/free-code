import { describe, expect, test } from 'bun:test'
import { ToolInputCoercionError } from '../../src/utils/toolErrors.js'
import { coerceEditInput } from '../../src/tools/FileEditTool/legacyInput.js'

describe('coerceEditInput', () => {
  test('passes canonical input through untouched', () => {
    const input = {
      file_path: '/x/f.ts',
      old_string: 'a',
      new_string: 'b',
    }
    expect(coerceEditInput(input)).toBe(input)
  })

  test('renames known aliases', () => {
    expect(
      coerceEditInput({
        path: '/x/f.ts',
        old_str: 'a',
        new_str: 'b',
        replaceAll: true,
        startLine: 3,
      }),
    ).toEqual({
      file_path: '/x/f.ts',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
      start_line: 3,
    })
  })

  test('does not clobber a canonical field already present', () => {
    expect(
      coerceEditInput({
        file_path: '/x/f.ts',
        path: '/y/g.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ).toEqual({
      file_path: '/x/f.ts',
      path: '/y/g.ts',
      old_string: 'a',
      new_string: 'b',
    })
  })

  test('anchored edits[] from pre-replacement transcripts fail loudly', () => {
    expect(() =>
      coerceEditInput({
        file_path: '/x/f.ts',
        edits: [{ op: 'replace', start: '3:abc', lines: 'x' }],
      }),
    ).toThrow(ToolInputCoercionError)
  })

  test('non-objects pass through', () => {
    expect(coerceEditInput(null)).toBe(null)
    expect(coerceEditInput(['x'])).toEqual(['x'])
  })
})
