import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool } from '../../src/Tool.js'
import {
  getMCPToolInputSchema,
  parseMCPToolInput,
} from '../../src/entrypoints/mcp.js'
import { isConcurrencySafeToolInput } from '../../src/services/tools/toolInput.js'
import { AskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { inputSchema as fileEditInputSchema } from '../../src/tools/FileEditTool/types.js'
import { getMethodAndParams } from '../../src/tools/LSPTool/LSPTool.js'
import { lspToolInputSchema } from '../../src/tools/LSPTool/schemas.js'
import { TaskStopTool } from '../../src/tools/TaskStopTool/TaskStopTool.js'

function makeTool(
  inputSchema: Tool['inputSchema'],
  overrides: Partial<Tool> = {},
): Tool {
  return {
    name: 'FakeTool',
    inputSchema,
    isConcurrencySafe: () => true,
    ...overrides,
  } as Tool
}

describe('model-facing and runtime tool schemas', () => {
  test('AskUserQuestion hides permission-component output fields from models', () => {
    const schema = getMCPToolInputSchema(AskUserQuestionTool) as {
      properties: Record<string, unknown>
    }

    expect(Object.keys(schema.properties)).toEqual(['questions'])
    expect(
      AskUserQuestionTool.inputSchema.safeParse({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
        answers: { 'Pick one?': 'A' },
        annotations: { 'Pick one?': { notes: 'because' } },
      }).success,
    ).toBe(true)
  })

  test('TaskStop exposes only task_id while retaining legacy shell_id runtime parsing', () => {
    const schema = getMCPToolInputSchema(TaskStopTool) as {
      properties: Record<string, unknown>
    }

    expect(Object.keys(schema.properties)).toEqual(['task_id'])
    expect(
      TaskStopTool.inputSchema.safeParse({ shell_id: 'legacy-id' }).success,
    ).toBe(true)
  })
})

describe('MCP tool boundary', () => {
  test('normalizes placeholders before runtime parsing', () => {
    const tool = makeTool(z.strictObject({ path: z.string().optional() }))

    expect(parseMCPToolInput(tool, { path: null })).toEqual({})
  })

  test('rejects malformed runtime input before invocation', () => {
    const tool = makeTool(z.strictObject({ path: z.string().optional() }))

    expect(() => parseMCPToolInput(tool, { path: 42 })).toThrow(
      'Tool FakeTool input is invalid',
    )
  })

  test('preserves externally owned JSON schemas', () => {
    const inputJSONSchema = {
      type: 'object' as const,
      properties: { dynamic: { type: 'string' } },
    }
    const tool = makeTool(z.strictObject({}), { inputJSONSchema })

    expect(getMCPToolInputSchema(tool)).toBe(inputJSONSchema)
  })
})

describe('concurrency-safe input classification', () => {
  test('normalizes optional strict placeholders before classification', () => {
    const tool = makeTool(z.strictObject({ path: z.string().optional() }))

    expect(isConcurrencySafeToolInput(tool, { path: null })).toBe(true)
    expect(isConcurrencySafeToolInput(tool, { path: 42 })).toBe(false)
  })

  test('fails closed when classification throws', () => {
    const tool = makeTool(z.strictObject({}), {
      isConcurrencySafe: () => {
        throw new Error('no')
      },
    })

    expect(isConcurrencySafeToolInput(tool, {})).toBe(false)
  })
})

describe('LSP operation-specific contracts', () => {
  test('document and workspace symbol operations do not require positions', () => {
    expect(
      lspToolInputSchema.safeParse({
        operation: 'documentSymbol',
        filePath: '/repo/file.ts',
      }).success,
    ).toBe(true)
    expect(
      lspToolInputSchema.safeParse({
        operation: 'workspaceSymbol',
        filePath: '/repo/file.ts',
        query: 'Widget',
      }).success,
    ).toBe(true)
  })

  test('position-based operations still require line and character', () => {
    expect(
      lspToolInputSchema.safeParse({
        operation: 'goToDefinition',
        filePath: '/repo/file.ts',
      }).success,
    ).toBe(false)
  })

  test('workspace query propagates and position mapping remains 1-based', () => {
    expect(
      getMethodAndParams(
        {
          operation: 'workspaceSymbol',
          filePath: '/repo/file.ts',
          query: 'Widget',
        },
        '/repo/file.ts',
      ),
    ).toEqual({ method: 'workspace/symbol', params: { query: 'Widget' } })
    expect(
      getMethodAndParams(
        {
          operation: 'goToDefinition',
          filePath: '/repo/file.ts',
          line: 2,
          character: 3,
        },
        '/repo/file.ts',
      ),
    ).toMatchObject({ params: { position: { line: 1, character: 2 } } })
  })
})

describe('FileEdit input schema', () => {
  test('accepts string-replacement input with optional fields omitted', () => {
    expect(
      fileEditInputSchema.safeParse({
        file_path: '/repo/x.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
      }).success,
    ).toBe(true)
  })

  test('coerces string booleans and numeric strings', () => {
    const parsed = fileEditInputSchema.safeParse({
      file_path: '/repo/x.ts',
      old_string: 'a',
      new_string: 'b',
      replace_all: 'true',
      start_line: '12',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.replace_all).toBe(true)
    expect(parsed.data?.start_line).toBe(12)
  })

  test('rejects the legacy edits array', () => {
    expect(
      fileEditInputSchema.safeParse({
        file_path: '/repo/x.ts',
        edits: [{ op: 'delete', start: '3:abc' }],
      }).success,
    ).toBe(false)
  })
})
