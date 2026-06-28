import { describe, expect, test } from 'bun:test'
import {
  adaptNewString,
  findActualString,
} from '../../src/tools/FileEditTool/utils.js'

const LDQUO = '\u201C'
const RDQUO = '\u201D'

function lines(...ls: string[]): string {
  return ls.join('\n')
}

describe('findActualString — existing behavior is unchanged', () => {
  test('exact match returns the search string verbatim', () => {
    const file = lines('const x = 1', 'const y = 2', '')
    expect(findActualString(file, 'const y = 2')).toBe('const y = 2')
  })

  test('curly-quote normalization returns the file substring', () => {
    const file = `say ${LDQUO}hi${RDQUO}`
    expect(findActualString(file, 'say "hi"')).toBe(file)
  })

  test('genuinely absent string returns null', () => {
    const file = lines('abc', 'def')
    expect(findActualString(file, lines('xyz', 'uvw'))).toBeNull()
  })
})

describe('findActualString — leaked Read line-number prefixes', () => {
  const file = lines('function f() {', '  return foo()', '}')

  test('strips a compact `N\\t` prefix', () => {
    expect(findActualString(file, '2\t  return foo()')).toBe('  return foo()')
  })

  test('strips a padded `␠␠␠␠␠N→` prefix', () => {
    expect(findActualString(file, '     2\u2192  return foo()')).toBe(
      '  return foo()',
    )
  })
})

describe('findActualString — whitespace tolerance', () => {
  test('ignores trailing whitespace and returns the real file line', () => {
    const file = lines('function f() {', '  return foo()', '}')
    expect(findActualString(file, '  return foo()   ')).toBe('  return foo()')
  })

  test('matches across a tab-vs-space indentation difference', () => {
    const file = lines('function f() {', '\treturn foo()', '}')
    expect(findActualString(file, '    return foo()')).toBe('\treturn foo()')
  })

  test('matches a uniformly dedented multi-line block', () => {
    const file = lines(
      'function f() {',
      '  if (x) {',
      '    doA()',
      '    doB()',
      '  }',
      '}',
    )
    expect(findActualString(file, lines('doA()', 'doB()'))).toBe(
      lines('    doA()', '    doB()'),
    )
  })
})

describe('findActualString — block-anchor (wrong interior line)', () => {
  const file = lines(
    'function compute() {',
    '  const a = 1',
    '  const b = 2',
    '  return a + b',
    '}',
  )

  test('anchors on first/last line and recovers the real interior', () => {
    const search = lines('  const a = 1', '  const bb = 999', '  return a + b')
    expect(findActualString(file, search)).toBe(
      lines('  const a = 1', '  const b = 2', '  return a + b'),
    )
  })

  test('replace_all skips single-location passes and fails closed', () => {
    const search = lines('  const a = 1', '  const bb = 999', '  return a + b')
    expect(findActualString(file, search, { replaceAll: true })).toBeNull()
  })
})

describe('findActualString — fuzzy last resort', () => {
  const block = [
    'line aaa',
    'line bbb',
    'line ccc',
    'line ddd',
    'line eee',
    'line fff',
    'line ggg',
    'line hhh',
    'line iii',
    'line jjj',
  ]

  test('matches a unique high-similarity window (one wrong line)', () => {
    const file = lines(...block)
    const search = lines('line aaaX', ...block.slice(1)) // 9/10 lines correct
    expect(findActualString(file, search)).toBe(file)
  })

  test('fails closed when two windows tie (ambiguous)', () => {
    const file = lines(...block, ...block) // two identical blocks
    const search = lines('line aaaX', ...block.slice(1))
    expect(findActualString(file, search)).toBeNull()
  })

  test('fails closed when best window is below the score threshold', () => {
    const file = lines('foo', 'bar', 'baz')
    const search = lines('foo', 'qux', 'zzz') // only 1/3 lines match
    expect(findActualString(file, search)).toBeNull()
  })
})

describe('adaptNewString', () => {
  test('identity when the match was exact', () => {
    expect(adaptNewString('a = 1', 'a = 1', 'a = 2')).toBe('a = 2')
  })

  test('strips leaked line-number prefixes from new_string', () => {
    expect(
      adaptNewString(
        '2\t  return foo()',
        '  return foo()',
        '2\t  return bar()',
      ),
    ).toBe('  return bar()')
  })

  test('re-applies a uniform indent that the model had dedented', () => {
    expect(
      adaptNewString(
        lines('doA()', 'doB()'),
        lines('    doA()', '    doB()'),
        lines('doX()', 'doY()'),
      ),
    ).toBe(lines('    doX()', '    doY()'))
  })

  test('bails to identity on incompatible (tab vs space) indentation', () => {
    expect(
      adaptNewString('    return foo()', '\treturn foo()', '    return bar()'),
    ).toBe('    return bar()')
  })
})
