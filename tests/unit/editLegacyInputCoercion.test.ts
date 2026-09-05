import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAnchor } from '../../src/utils/hashline.js'
import { ToolInputCoercionError } from '../../src/utils/toolErrors.js'
import { coerceLegacyEditInput } from '../../src/tools/FileEditTool/legacyInput.js'

const dir = mkdtempSync(join(tmpdir(), 'edit-coercion-'))
function file(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('coerceLegacyEditInput', () => {
  test('converts legacy fields inside an edits entry', () => {
    const path = file('a.ts', ['one', 'two', 'three'].join('\n'))
    const out = coerceLegacyEditInput({
      file_path: path,
      edits: [{ oldText: 'two', newText: 'TWO' }],
    }) as {
      file_path: string
      edits: Array<{ op: string; start: string; end?: string; lines: string }>
    }
    expect(out.edits).toHaveLength(1)
    const e = out.edits[0]!
    expect(e.op).toBe('replace')
    expect(parseAnchor(e.start)).toEqual({ line: 2, hash: expect.any(String) })
    expect(e.end).toBeUndefined()
    expect(e.lines).toBe('TWO')
  })

  test('converts top-level snake_case legacy fields (no edits array)', () => {
    const path = file('b.ts', ['x', 'y'].join('\n'))
    const out = coerceLegacyEditInput({
      file_path: path,
      old_string: 'x',
      new_string: 'X',
    }) as { edits: Array<{ start: string; lines: string }> }
    expect(out.edits).toHaveLength(1)
    expect(parseAnchor(out.edits[0]!.start)).toEqual({
      line: 1,
      hash: expect.any(String),
    })
    expect(out.edits[0]!.lines).toBe('X')
  })

  test('multi-line match gets an end anchor', () => {
    const path = file('c.ts', ['a', 'b', 'c', 'd'].join('\n'))
    const out = coerceLegacyEditInput({
      file_path: path,
      edits: [{ old_string: 'b\nc', new_string: 'BC' }],
    }) as { edits: Array<{ start: string; end?: string; lines: string }> }
    const e = out.edits[0]!
    expect(parseAnchor(e.start!)!.line).toBe(2)
    expect(parseAnchor(e.end!)!.line).toBe(3)
    expect(e.lines).toBe('BC')
  })

  test('substring replacement preserves the rest of the line', () => {
    const path = file('d.ts', 'const value = compute(a, b)')
    const out = coerceLegacyEditInput({
      file_path: path,
      edits: [{ old_string: 'compute(a, b)', new_string: 'compute(x, y)' }],
    }) as { edits: Array<{ lines: string }> }
    expect(out.edits[0]!.lines).toBe('const value = compute(x, y)')
  })

  test('not-found match throws a teaching error', () => {
    const path = file('e.ts', 'alpha\nbeta')
    expect(() =>
      coerceLegacyEditInput({
        file_path: path,
        edits: [{ old_string: 'gamma', new_string: 'g' }],
      }),
    ).toThrow(ToolInputCoercionError)
    expect(() =>
      coerceLegacyEditInput({
        file_path: path,
        edits: [{ old_string: 'gamma', new_string: 'g' }],
      }),
    ).toThrow(/not found/)
  })

  test('ambiguous match lists the candidate anchors', () => {
    const path = file('f.ts', ['dup', 'x', 'dup'].join('\n'))
    let message = ''
    try {
      coerceLegacyEditInput({
        file_path: path,
        edits: [{ old_string: 'dup', new_string: 'd' }],
      })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('matches 2 places')
    expect(message).toMatch(/anchors 1:[0-9a-z]+, 3:[0-9a-z]+/)
  })

  test('replace_all yields one edit per match cluster', () => {
    const path = file('g.ts', ['dup', 'x', 'dup'].join('\n'))
    const out = coerceLegacyEditInput({
      file_path: path,
      edits: [{ old_string: 'dup', new_string: 'd', replace_all: true }],
    }) as { edits: Array<{ start: string }> }
    expect(out.edits).toHaveLength(2)
    expect(out.edits.map(e => parseAnchor(e.start)!.line)).toEqual([1, 3])
  })

  test('two matches on one line share one clustered edit', () => {
    const path = file('h.ts', 'dup(a) + dup(b)')
    const out = coerceLegacyEditInput({
      file_path: path,
      edits: [{ old_string: 'dup', new_string: 'D', replace_all: true }],
    }) as { edits: Array<{ start: string; end?: string; lines: string }> }
    expect(out.edits).toHaveLength(1)
    expect(out.edits[0]!.lines).toBe('D(a) + D(b)')
  })

  test('canonical input passes through untouched', () => {
    const input = {
      file_path: '/nonexistent',
      edits: [{ op: 'replace', start: '3:a3f', lines: 'x' }],
    }
    expect(coerceLegacyEditInput(input)).toBe(input)
  })

  test('synthetic top-level legacy fields with an edits array are ignored', () => {
    const input = {
      file_path: '/nonexistent',
      edits: [{ op: 'replace', start: '3:a3f', lines: 'x' }],
      old_string: 'whole-file-copy',
      new_string: 'whole-file-copy',
    }
    expect(coerceLegacyEditInput(input)).toBe(input)
  })
})
