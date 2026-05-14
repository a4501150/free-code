import { describe, test, expect } from 'bun:test'
import {
  renderToolCallParams,
  type ToolCallDisplayMode,
} from '../../src/components/messages/ToolCallParams.js'

describe('renderToolCallParams', () => {
  const input = {
    file_path: '/src/foo.ts',
    old_string: 'const a = 1',
    new_string: 'const b = 2',
    replace_all: false,
  }

  test('compact mode without compactParamKeys shows all params', () => {
    const result = renderToolCallParams(input, 'compact')
    expect(result).toContain('file_path:')
    expect(result).toContain('old_string:')
    expect(result).toContain('new_string:')
    expect(result).toContain('replace_all:')
  })

  test('compact mode with compactParamKeys shows only listed keys', () => {
    const result = renderToolCallParams(input, 'compact', ['file_path'])
    expect(result).toContain('file_path:')
    expect(result).not.toContain('old_string')
    expect(result).not.toContain('new_string')
    expect(result).not.toContain('replace_all')
  })

  test('compactParamKeys preserves declared order', () => {
    const result = renderToolCallParams(input, 'compact', [
      'replace_all',
      'file_path',
    ])
    const replaceIdx = result.indexOf('replace_all')
    const fileIdx = result.indexOf('file_path')
    expect(replaceIdx).toBeLessThan(fileIdx)
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

  test('no "…+N more" suffix for intentionally hidden params', () => {
    const result = renderToolCallParams(input, 'compact', ['file_path'])
    expect(result).not.toContain('more')
  })

  test('full mode ignores compactParamKeys', () => {
    const result = renderToolCallParams(input, 'full', ['file_path'])
    expect(result).toContain('file_path:')
    expect(result).toContain('old_string:')
    expect(result).toContain('new_string:')
    expect(result).toContain('replace_all:')
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

  test('compact mode without compactParamKeys caps at 6 params', () => {
    const manyParams: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) {
      manyParams[`key${i}`] = `val${i}`
    }
    const result = renderToolCallParams(manyParams, 'compact')
    expect(result).toContain('…+4 more')
  })
})
