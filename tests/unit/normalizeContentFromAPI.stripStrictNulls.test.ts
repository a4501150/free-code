/**
 * Unit test: normalizeContentFromAPI strips `null` values that strict-mode
 * providers (OpenAI structured outputs) emit for `.optional()` non-nullable
 * fields. Without this, UI-side `tool.inputSchema.safeParse(content.input)`
 * fails on the rendered tool-use block, hiding the entire tool-use header
 * (e.g. `● Skill(frontend-design)`) and leaving only the tool result line
 * (`└ Successfully loaded skill`) visible.
 */
import { describe, test, expect } from 'bun:test'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { z } from 'zod/v4'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import { GrepTool } from '../../src/tools/GrepTool/GrepTool.js'
import { SkillTool } from '../../src/tools/SkillTool/SkillTool.js'
import { normalizeContentFromAPI } from '../../src/utils/messages.js'
import { semanticBoolean } from '../../src/utils/semanticBoolean.js'
import { semanticNumber } from '../../src/utils/semanticNumber.js'
import { stripStrictNullInputs } from '../../src/utils/stripStrictNullInputs.js'

describe('normalizeContentFromAPI strips strict-mode nulls', () => {
  test('optional non-nullable string field with null is removed and Zod parse succeeds', () => {
    // OpenAI strict mode emits null for omitted optional fields. SkillTool's
    // `args` is `z.string().optional()` — non-nullable.
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: 'toolu_test_1',
      name: 'Skill',
      input: { skill: 'frontend-design:frontend-design', args: null },
    } as unknown as BetaContentBlock

    const [normalized] = normalizeContentFromAPI(
      [toolUseBlock],
      [SkillTool],
    ) as Array<{ type: string; input: unknown }>

    expect(normalized.type).toBe('tool_use')
    // `args: null` must be stripped; `skill` preserved.
    expect(normalized.input).toEqual({
      skill: 'frontend-design:frontend-design',
    })

    // The downstream UI-side parse that AssistantToolUseMessage performs.
    const parsed = SkillTool.inputSchema.safeParse(normalized.input)
    expect(parsed.success).toBe(true)
  })

  test('input with no nulls is unchanged', () => {
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: 'toolu_test_2',
      name: 'Skill',
      input: { skill: 'commit', args: '-m "fix"' },
    } as unknown as BetaContentBlock

    const [normalized] = normalizeContentFromAPI(
      [toolUseBlock],
      [SkillTool],
    ) as Array<{ type: string; input: unknown }>

    expect(normalized.input).toEqual({ skill: 'commit', args: '-m "fix"' })
  })

  test('unknown tool name leaves input untouched', () => {
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: 'toolu_test_3',
      name: 'NoSuchTool',
      input: { foo: null, bar: 'baz' },
    } as unknown as BetaContentBlock

    const [normalized] = normalizeContentFromAPI(
      [toolUseBlock],
      [SkillTool],
    ) as Array<{ type: string; input: unknown }>

    // No tool to look up → no schema-aware stripping; input passes through.
    expect(normalized.input).toEqual({ foo: null, bar: 'baz' })
  })

  // FileReadTool/GrepTool/BashTool/PowerShellTool wrap their optional numeric
  // fields in `semanticNumber()`, which is `z.preprocess(...)` and reports
  // `_def.type === 'pipe'`. Plain `_def.type === 'optional'` checks miss
  // those, so strict-mode `null` slipped through and broke gpt-5.5 calls
  // ("Read tool failed many times").
  test('FileReadTool: semanticNumber-wrapped offset/limit nulls are stripped', () => {
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: 'toolu_read_1',
      name: 'Read',
      input: {
        file_path: '/tmp/x.ts',
        offset: null,
        limit: null,
        pages: null,
      },
    } as unknown as BetaContentBlock

    const [normalized] = normalizeContentFromAPI(
      [toolUseBlock],
      [FileReadTool],
    ) as Array<{ type: string; input: unknown }>

    expect(normalized.input).toEqual({ file_path: '/tmp/x.ts' })
    const parsed = FileReadTool.inputSchema.safeParse(normalized.input)
    expect(parsed.success).toBe(true)
  })

  test('GrepTool: every semanticNumber-wrapped field accepts strict-mode null', () => {
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: 'toolu_grep_1',
      name: 'Grep',
      input: {
        pattern: 'foo',
        path: null,
        glob: null,
        type: null,
        output_mode: null,
        '-i': null,
        '-n': null,
        '-B': null,
        '-A': null,
        '-C': null,
        context: null,
        multiline: null,
        head_limit: null,
        offset: null,
      },
    } as unknown as BetaContentBlock

    const [normalized] = normalizeContentFromAPI(
      [toolUseBlock],
      [GrepTool],
    ) as Array<{ type: string; input: unknown }>

    const parsed = GrepTool.inputSchema.safeParse(normalized.input)
    expect(parsed.success).toBe(true)
  })

  // Direct stripStrictNullInputs unit tests for the wrapper-shape matrix.
  describe('stripStrictNullInputs wrapper matrix', () => {
    test('semanticNumber(optional) — pipe → optional → number — strips null', () => {
      const schema = z.object({
        n: semanticNumber(z.number().int().optional()),
      })
      expect(stripStrictNullInputs(schema, { n: null })).toEqual({})
    })

    test('semanticBoolean(optional) — pipe → optional → boolean — strips null', () => {
      const schema = z.object({
        b: semanticBoolean(z.boolean().optional()),
      })
      expect(stripStrictNullInputs(schema, { b: null })).toEqual({})
    })

    test('semanticBoolean(default(false).optional()) — default-then-optional under pipe — strips null', () => {
      const schema = z.object({
        b: semanticBoolean(z.boolean().default(false).optional()),
      })
      expect(stripStrictNullInputs(schema, { b: null })).toEqual({})
    })

    test('plain .optional() — outer optional — strips null (regression-guard)', () => {
      const schema = z.object({ s: z.string().optional() })
      expect(stripStrictNullInputs(schema, { s: null })).toEqual({})
    })

    test('plain .nullable() — does NOT strip null', () => {
      const schema = z.object({ s: z.string().nullable() })
      expect(stripStrictNullInputs(schema, { s: null })).toEqual({ s: null })
    })

    test('.optional().nullable() — does NOT strip null', () => {
      const schema = z.object({ s: z.string().optional().nullable() })
      expect(stripStrictNullInputs(schema, { s: null })).toEqual({ s: null })
    })

    test('semanticNumber(nullable.optional) — pipe over nullable — does NOT strip null', () => {
      const schema = z.object({
        n: semanticNumber(z.number().nullable().optional()),
      })
      expect(stripStrictNullInputs(schema, { n: null })).toEqual({ n: null })
    })

    test('non-null values pass through every wrapper', () => {
      const schema = z.object({
        n: semanticNumber(z.number().int().optional()),
        b: semanticBoolean(z.boolean().optional()),
        s: z.string().optional(),
      })
      const input = { n: 5, b: true, s: 'hi' }
      expect(stripStrictNullInputs(schema, input)).toEqual(input)
    })
  })
})
