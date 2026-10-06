import { describe, test, expect } from 'bun:test'
import {
  renderToolCallParams,
  type ToolCallDisplayMode,
} from '../../src/components/messages/ToolCallParams.js'

describe('renderToolCallParams', () => {
  const input = {
    file_path: '/src/foo.ts',
    edits: [{ op: 'replace', start: '1:abc', lines: 'const b = 2' }],
  }

  test('compact mode without compactParamKeys shows all params', () => {
    const result = renderToolCallParams(input, 'compact')
    expect(result).toContain('file_path:')
    expect(result).toContain('edits:')
  })

  test('compact mode with compactParamKeys shows only listed keys', () => {
    const result = renderToolCallParams(input, 'compact', ['file_path'])
    expect(result).toContain('file_path:')
    expect(result).not.toContain('edits')
  })

  test('compactParamKeys preserves declared order', () => {
    const result = renderToolCallParams(input, 'compact', [
      'edits',
      'file_path',
    ])
    const editsIdx = result.indexOf('edits')
    const fileIdx = result.indexOf('file_path')
    expect(editsIdx).toBeLessThan(fileIdx)
  })

  test('compactParamKeys skips keys not present in input', () => {
    const result = renderToolCallParams(input, 'compact', [
      'file_path',
      'nonexistent_key',
    ])
    expect(result).toContain('file_path:')
    expect(result).not.toContain('nonexistent_key')
  })

  test('compactParamKeys skips null values', () => {
    const inputWithNull = { ...input, offset: null }
    const result = renderToolCallParams(inputWithNull, 'compact', [
      'file_path',
      'offset',
    ])
    expect(result).toContain('file_path:')
    expect(result).not.toContain('offset')
  })

  test('compactParamKeys skips undefined values', () => {
    const inputWithUndef = { ...input, limit: undefined }
    const result = renderToolCallParams(inputWithUndef, 'compact', [
      'file_path',
      'limit',
    ])
    expect(result).toContain('file_path:')
    expect(result).not.toContain('limit')
  })

  test('undefined values are skipped without compactParamKeys', () => {
    // RunCode bridge child calls can carry explicit undefined values,
    // which JSON.stringify renders as no output at all.
    const inputWithUndef = { ...input, limit: undefined }
    const result = renderToolCallParams(inputWithUndef, 'compact')
    expect(result).toContain('file_path:')
    expect(result).not.toContain('limit')
  })

  test('symbol values render via String() instead of throwing', () => {
    const result = renderToolCallParams({ sym: Symbol('x') }, 'full')
    expect(result).toContain('sym: Symbol(x)')
  })

  test('no "…+N more" suffix for intentionally hidden params', () => {
    const result = renderToolCallParams(input, 'compact', ['file_path'])
    expect(result).not.toContain('more')
  })

  test('full mode ignores compactParamKeys', () => {
    const result = renderToolCallParams(input, 'full', ['file_path'])
    expect(result).toContain('file_path:')
    expect(result).toContain('edits:')
  })

  test('empty compactParamKeys array returns empty string in compact mode', () => {
    const result = renderToolCallParams(input, 'compact', [])
    expect(result).toBe('')
  })

  test('empty input returns empty string', () => {
    const result = renderToolCallParams({}, 'compact')
    expect(result).toBe('')
  })

  test('truncates long values in compact mode', () => {
    const longInput = { key: 'a'.repeat(200) }
    const result = renderToolCallParams(longInput, 'compact')
    expect(result.length).toBeLessThan(200)
    expect(result).toContain('…')
  })

  test('multiline values render on one line', () => {
    // RunCode child calls often echo a previous result blob as an input
    // value; escaped and real newlines must not break the tool row.
    const blobby = { instance_id: '### Result\n{\n  "a": 1\n}' }
    const compact = renderToolCallParams(blobby, 'compact')
    expect(compact).not.toContain('\\n')
    expect(compact).toContain('### Result {')
    const full = renderToolCallParams({ tabbed: 'a\tb\nc' }, 'full')
    expect(full).not.toContain('\\n')
    expect(full).not.toContain('\\t')
  })

  test('compact mode without compactParamKeys caps at 6 params', () => {
    const manyParams: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) {
      manyParams[`key${i}`] = `val${i}`
    }
    const result = renderToolCallParams(manyParams, 'compact')
    expect(result).toContain('…+4 more')
  })
})
