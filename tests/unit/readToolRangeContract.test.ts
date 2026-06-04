import { describe, expect, test } from 'bun:test'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../../src/Tool.js'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'

const context = {
  getAppState: () => ({
    toolPermissionContext: getEmptyToolPermissionContext(),
  }),
} as ToolUseContext

describe('Read range contract', () => {
  test('allows full-file intent and large safe partial ranges', () => {
    expect(
      FileReadTool.inputSchema.safeParse({ file_path: '/repo/src/file.ts' })
        .success,
    ).toBe(true)
    expect(
      FileReadTool.inputSchema.safeParse({
        file_path: '/repo/src/file.ts',
        offset: 5000,
        limit: 50000,
      }).success,
    ).toBe(true)
  })

  test('rejects non-safe offset and limit values', () => {
    expect(
      FileReadTool.inputSchema.safeParse({
        file_path: '/repo/src/file.ts',
        offset: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false)
    expect(
      FileReadTool.inputSchema.safeParse({
        file_path: '/repo/src/file.ts',
        limit: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false)
  })

  test('documents basic usage semantics', async () => {
    const prompt = await FileReadTool.prompt({
      getToolPermissionContext: async () => ({}) as never,
      tools: [FileReadTool],
      agents: [],
    })

    expect(prompt).toContain('provide only `file_path` to read the full file')
    expect(prompt).toContain(
      'To read a portion, provide `offset`, `limit`, or both',
    )
  })

  test('rejects pages for non-PDF files', async () => {
    const result = await FileReadTool.validateInput?.(
      { file_path: '/repo/src/file.ts', pages: '1-2' },
      context,
    )

    expect(result).toMatchObject({
      result: false,
      errorCode: 10,
    })
  })

  test('rejects page ranges mixed with text line ranges', async () => {
    const result = await FileReadTool.validateInput?.(
      { file_path: '/repo/spec.pdf', pages: '1-2', limit: 2 },
      context,
    )

    expect(result).toMatchObject({
      result: false,
      errorCode: 11,
    })
  })

  test('accepts a valid PDF page-range request', async () => {
    const result = await FileReadTool.validateInput?.(
      { file_path: '/repo/spec.pdf', pages: '1-2' },
      context,
    )

    expect(result).toEqual({ result: true })
  })
})
