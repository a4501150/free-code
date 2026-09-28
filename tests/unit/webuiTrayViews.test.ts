import { describe, expect, test } from 'bun:test'
import {
  buildAllowDecision,
  elicitationContent,
  elicitationFields,
  parseUpdatedInput,
} from '../../src/webui/client/trayViews.js'

describe('elicitation fields', () => {
  test('maps the MCP schema types a browser can render', () => {
    const fields = elicitationFields({
      message: 'configure',
      requestedSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', title: 'Repository' },
          depth: { type: 'number', description: 'How deep' },
          force: { type: 'boolean' },
          mode: { type: 'string', enum: ['shallow', 'full'] },
          nested: { type: 'object' },
        },
        required: ['repo'],
      },
    })
    expect(fields.map(f => [f.name, f.type, f.required])).toEqual([
      ['repo', 'text', true],
      ['depth', 'number', false],
      ['force', 'checkbox', false],
      ['mode', 'select', false],
    ])
    expect(fields[0]!.label).toBe('Repository')
    expect(fields[1]!.description).toBe('How deep')
    expect(fields[3]!.options).toEqual(['shallow', 'full'])
  })

  test('garbage params yield no fields, not a crash', () => {
    expect(elicitationFields(null)).toEqual([])
    expect(elicitationFields({})).toEqual([])
    expect(elicitationFields({ requestedSchema: { properties: 3 } })).toEqual(
      [],
    )
  })
})

describe('elicitation content', () => {
  const fields = elicitationFields({
    requestedSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        depth: { type: 'number' },
        force: { type: 'boolean' },
      },
      required: ['repo'],
    },
  })

  test('a blank optional number is absent, not zero', () => {
    const result = elicitationContent(fields, { repo: 'x', depth: '' })
    expect(result).toEqual({
      ok: true,
      content: { repo: 'x', force: false },
    })
  })

  test('a missing required field answers with its label', () => {
    const result = elicitationContent(fields, { depth: '2' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('repo')
  })

  test('a non-numeric number is rejected before the request', () => {
    const result = elicitationContent(fields, { repo: 'x', depth: 'deep' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('number')
  })

  test('checkboxes always answer, checked or not', () => {
    const result = elicitationContent(fields, {
      repo: 'x',
      force: true,
    })
    expect(result.ok && result.content.force).toBe(true)
  })
})

describe('permission allow decision', () => {
  const original = { command: 'ls', description: 'list' }

  test('an unchanged pane ships a plain allow', () => {
    const result = buildAllowDecision({
      persist: false,
      setMode: null,
      editedInput: JSON.stringify(original),
      originalInput: original,
    })
    expect(result).toEqual({ ok: true, decision: { behavior: 'allow' } })
  })

  test('an edited pane becomes updatedInput', () => {
    const result = buildAllowDecision({
      persist: true,
      setMode: 'acceptEdits',
      editedInput: JSON.stringify({ command: 'ls -la' }),
      originalInput: original,
    })
    expect(result).toEqual({
      ok: true,
      decision: {
        behavior: 'allow',
        persist: true,
        setMode: 'acceptEdits',
        updatedInput: { command: 'ls -la' },
      },
    })
  })

  test('garbage JSON is an error, never a request', () => {
    const result = buildAllowDecision({
      persist: false,
      setMode: null,
      editedInput: '{oops',
      originalInput: original,
    })
    expect(result.ok).toBe(false)
  })

  test('parseUpdatedInput demands an object', () => {
    expect(parseUpdatedInput('[1,2]').ok).toBe(false)
    expect(parseUpdatedInput('"hello"').ok).toBe(false)
    expect(parseUpdatedInput('null').ok).toBe(false)
    expect(parseUpdatedInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })
})
