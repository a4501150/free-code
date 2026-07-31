import { describe, test, expect } from 'bun:test'
import { z } from 'zod'

import { stripStrictNullInputs } from '../../src/utils/stripStrictNullInputs.js'

// An MCP tool's schema reaches us as JSON Schema, shaped like agent-browser's:
// `profile` admits null on purpose ("throwaway profile"), `text` is required.
const mcpSchema = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    text: { type: 'string' },
    checked: { type: 'boolean' },
    element: { type: 'string' },
    profile: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['target', 'text'],
}

describe('stripStrictNullInputs with a JSON Schema', () => {
  test('drops a null an optional field does not admit', () => {
    expect(
      stripStrictNullInputs(mcpSchema, {
        target: '#b',
        text: 'hi',
        checked: null,
        element: null,
      }),
    ).toEqual({ target: '#b', text: 'hi' })
  })

  test('keeps a null the schema admits', () => {
    expect(stripStrictNullInputs(mcpSchema, { profile: null })).toEqual({
      profile: null,
    })
  })

  test('keeps an empty string a required field carries', () => {
    expect(
      stripStrictNullInputs(mcpSchema, { target: '#t', text: '' }),
    ).toEqual({ target: '#t', text: '' })
  })

  test('still drops an empty string from an optional field', () => {
    expect(
      stripStrictNullInputs(mcpSchema, {
        target: '#t',
        text: 'x',
        element: '',
      }),
    ).toEqual({ target: '#t', text: 'x' })
  })

  test('drops a placeholder for a key the schema does not describe', () => {
    expect(stripStrictNullInputs(mcpSchema, { unknown_key: null })).toEqual({})
  })

  test('returns the same object when nothing is stripped', () => {
    const input = { target: '#b', text: 'hi' }
    expect(stripStrictNullInputs(mcpSchema, input)).toBe(input)
  })
})

const zodSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().optional(),
  profile: z.string().nullable().optional(),
  nested: z.object({ inner: z.string().optional() }).optional(),
})

describe('stripStrictNullInputs with a Zod schema', () => {
  test('drops a null an optional field does not admit', () => {
    expect(
      stripStrictNullInputs(zodSchema, { command: 'ls', timeout: null }),
    ).toEqual({ command: 'ls' })
  })

  test('keeps a null a nullable field admits', () => {
    expect(
      stripStrictNullInputs(zodSchema, { command: 'ls', profile: null }),
    ).toEqual({ command: 'ls', profile: null })
  })

  test('keeps an empty string a required field carries', () => {
    expect(stripStrictNullInputs(zodSchema, { command: '' })).toEqual({
      command: '',
    })
  })

  test('still drops an empty string from an optional field', () => {
    expect(
      stripStrictNullInputs(zodSchema, { command: 'ls', description: '' }),
    ).toEqual({ command: 'ls' })
  })

  test('cleans nested objects', () => {
    expect(
      stripStrictNullInputs(zodSchema, {
        command: 'ls',
        nested: { inner: null },
      }),
    ).toEqual({ command: 'ls', nested: {} })
  })

  test('leaves arrays alone', () => {
    const input = { command: 'ls', fields: [{ value: '' }] }
    expect(stripStrictNullInputs(zodSchema, input)).toEqual(input)
  })

  test('strips unconditionally with no schema at all', () => {
    expect(stripStrictNullInputs(undefined, { a: null, b: '', c: 1 })).toEqual({
      c: 1,
    })
  })
})
