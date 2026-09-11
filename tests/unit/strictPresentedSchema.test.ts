import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { toJSONSchema } from 'zod/v4/core'
import { toPresentedToolSchema } from '../../src/services/api/adapters/strictPresentedSchema.js'

describe('toPresentedToolSchema', () => {
  test('renders optionals as required-nullable and strips draft keywords', () => {
    const schema = toJSONSchema(
      z.strictObject({
        file_path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        pages: z.string().optional(),
      }),
      { target: 'draft-2020-12' },
    ) as Record<string, unknown>
    const out = toPresentedToolSchema(schema)
    expect(out['$schema']).toBeUndefined()
    expect(out['required']).toEqual(
      expect.arrayContaining(['file_path', 'offset', 'pages']),
    )
    expect(out['additionalProperties']).toBe(false)
    const props = out['properties'] as Record<string, Record<string, unknown>>
    // Required fields are nullable too: strict shape says "unset" with null.
    expect(props['file_path']?.['type']).toEqual(['string', 'null'])
    expect(props['offset']?.['type']).toEqual(['integer', 'null'])
    expect(props['pages']?.['type']).toEqual(['string', 'null'])
  })

  test('keeps a schema using local $refs untouched', () => {
    const schema = {
      type: 'object',
      $defs: { X: { type: 'string' } },
      properties: { a: { $ref: '#/$defs/X' } },
    }
    expect(toPresentedToolSchema(schema)).toBe(schema)
  })

  test('adds a null branch to anyOf unions', () => {
    const out = toPresentedToolSchema({
      type: 'object',
      properties: {
        mode: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    })
    const props = out['properties'] as Record<string, Record<string, unknown>>
    const branches = props['mode']?.['anyOf'] as Array<Record<string, unknown>>
    expect(branches.some(b => b['type'] === 'null')).toBe(true)
    expect(out['required']).toEqual(['mode'])
  })

  test('empty schema still presents a closed object', () => {
    expect(toPresentedToolSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
    })
    const out = toPresentedToolSchema({ type: 'object', properties: {} })
    expect(out['required']).toEqual([])
    expect(out['additionalProperties']).toBe(false)
  })
})
