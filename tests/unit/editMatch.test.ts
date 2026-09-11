import { describe, expect, test } from 'bun:test'
import {
  planEdit,
  stripLineRowPrefixes,
  type EditPlanRequest,
} from '../../src/utils/editMatch.js'

function edit(
  fileText: string,
  oldString: string,
  newString: string,
  extra: Partial<Pick<EditPlanRequest, 'replaceAll'>> = {},
) {
  return planEdit(fileText, {
    oldString,
    newString,
    replaceAll: false,
    ...extra,
  })
}

describe('planEdit — exact matches', () => {
  test('replaces a unique match and reports its span', () => {
    const r = edit(
      'line one\nconst a = 1\nline three',
      'const a = 1',
      'const a = 2',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.updatedContent).toBe('line one\nconst a = 2\nline three')
    expect(r.plan.strategy).toBe('exact')
    expect(r.plan.spans).toHaveLength(1)
    expect(r.plan.spans[0]!.startLine).toBe(2)
    expect(r.plan.spans[0]!.endLine).toBe(2)
  })

  test('missing string fails with errorCode 8', () => {
    const r = edit('a\nb', 'zzz', 'x')
    expect(!r.ok && r.failure.errorCode).toBe(8)
  })

  test('empty new_string removes the matched text and its line break', () => {
    const r = edit('a\nb\nc', 'b', '')
    expect(r.ok && r.plan.updatedContent).toBe('a\nc')
  })

  test('empty new_string at end of file just removes the text', () => {
    const r = edit('a\nbx', 'x', '')
    expect(r.ok && r.plan.updatedContent).toBe('a\nb')
  })
})

describe('planEdit — multi-match and disambiguation', () => {
  const dup = 'dup x\nkeep\ndup x\ndrop\ndup x'

  test('multiple matches without replace_all fail with the count and candidate lines', () => {
    const r = edit(dup, 'dup x', 'mark')
    expect(!r.ok && r.failure.errorCode).toBe(9)
    expect(!r.ok && r.failure.message).toContain('3 matches')
    // Line numbers of every candidate so the retry can widen context once.
    expect(!r.ok && r.failure.message).toContain(
      'Matches start at lines: 1, 3, 5',
    )
  })

  test('multi-match ambiguity is resolved by extending old_string', () => {
    const r = edit(dup, 'keep\ndup x', 'keep\nmark')
    expect(r.ok && r.plan.updatedContent).toBe('dup x\nkeep\nmark\ndrop\ndup x')
  })

  test('replace_all replaces every occurrence', () => {
    const r = edit(dup, 'dup x', 'mark', { replaceAll: true })
    expect(r.ok && r.plan.updatedContent).toBe('mark\nkeep\nmark\ndrop\nmark')
    expect(r.ok && r.plan.spans).toHaveLength(3)
  })
})

describe('planEdit — whitespace-tolerant whole-line pass', () => {
  test('multi-line copy with drifted indentation matches whole lines', () => {
    const file = 'function f() {\n    const a = 1;\n    const b = 2;\n}'
    const r = edit(file, 'const a = 1;\nconst b = 2;', 'const c = 3;')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.strategy).toBe('whitespace')
    expect(r.plan.updatedContent).toBe('function f() {\nconst c = 3;\n}')
    expect(r.plan.spans[0]!.startLine).toBe(2)
    expect(r.plan.spans[0]!.endLine).toBe(3)
  })

  test('trailing-whitespace drift matches and leaves the rest of the line intact', () => {
    const file = 'one\nalpha\nbeta\nthree'
    const r = edit(file, 'alpha  \nbeta', 'ALPHA\nBETA')
    expect(r.ok && r.plan.strategy).toBe('whitespace')
    expect(r.ok && r.plan.updatedContent).toBe('one\nALPHA\nBETA\nthree')
  })

  test('single-line substring match stays an exact match, not the whitespace pass', () => {
    const r = edit('leading  indented line', 'indented line', 'x')
    expect(r.ok && r.plan.strategy).toBe('exact')
  })

  test('a whitespace-matching multi-line copy spanning different content still needs uniqueness', () => {
    const file = 'a\nx\ny\nb\nx\ny\nc'
    const r = edit(file, ' x\n y', 'z')
    expect(!r.ok && r.failure.errorCode).toBe(9)
    expect(!r.ok && r.failure.message).toContain('Matches start at lines: 2, 5')
  })

  test('empty new_string deletes the whole whitespace-matched lines', () => {
    const file = 'keep\n  drop me\n  me too\nkeep2'
    const r = edit(file, 'drop me\nme too', '')
    expect(r.ok && r.plan.updatedContent).toBe('keep\nkeep2')
  })
})

describe('planEdit — repair retries', () => {
  test('curly-quoted old_string matches a straight-quote file and re-curves new_string', () => {
    const r = edit(
      'const s = "hi"\n',
      'const s = \u201Chi\u201D',
      'const s = "bye"',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.strategy).toBe('quotes')
    expect(r.plan.updatedContent).toBe('const s = \u201Cbye\u201D\n')
  })

  test('straight-quoted old_string against a curly-quote file is not silently repaired', () => {
    const r = edit(
      'const s = \u201Chi\u201D\n',
      'const s = "hi"',
      'const s = "bye"',
    )
    // The repair is one-directional (like official): a curly file displays as
    // curly in Read output, so the model naturally quotes the curly form.
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.message).toContain('not found')
  })

  test('backslash-u escapes in old_string match raw file characters and new_string is un-escaped too', () => {
    const r = edit(
      'const s = "caf\u00E9"\n',
      'const s = "caf\\u00e9"',
      'const s = "caf\u00E9 au lait"',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.strategy).toBe('escapes')
    expect(r.plan.updatedContent).toBe('const s = "caf\u00E9 au lait"\n')
  })

  test('raw characters in old_string match escape text in the file', () => {
    const r = edit(
      'const s = "caf\\u00E9"\n',
      'const s = "caf\u00E9"',
      'const s = "caf\u00E9!"',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.strategy).toBe('escapes')
    // Written text follows the file's escape encoding and hex case.
    expect(r.plan.updatedContent).toBe('const s = "caf\\u00E9!"\n')
  })

  test('pasted Read rows are repaired by stripping the N: prefix', () => {
    const file = 'a\nconst a = 1\nb'
    const r = edit(file, '2:const a = 1', '2:const a = 2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.strategy).toBe('line-prefix')
    expect(r.plan.updatedContent).toBe('a\nconst a = 2\nb')
  })

  test('non-ascending pasted line numbers are not repaired', () => {
    const r = edit('a\nb', '1:x\n3:y', 'z')
    expect(!r.ok).toBe(true)
  })
})

describe('stripLineRowPrefixes', () => {
  test('keeps hashline-era and cat -n prefixes out of stripped rows', () => {
    expect(stripLineRowPrefixes('12:a3f|  return x')).toBe('  return x')
    expect(stripLineRowPrefixes('12:  return x')).toBe('  return x')
    expect(stripLineRowPrefixes('12\t  return x')).toBe('  return x')
    expect(stripLineRowPrefixes('no prefix')).toBe(null)
  })

  test('multi-line input must have consecutive ascending numbers', () => {
    expect(stripLineRowPrefixes('10:a\n11:b')).toBe('a\nb')
    expect(stripLineRowPrefixes('10:a\n12:b')).toBe(null)
  })
})
