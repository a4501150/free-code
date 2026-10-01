import { describe, expect, test } from 'bun:test'

import { extractBashSearchPattern } from '../../src/tools/BashTool/searchPatternExtraction.js'

describe('extractBashSearchPattern', () => {
  test('rg/grep: first positional is the pattern', () => {
    expect(extractBashSearchPattern('rg -n memories src/')).toBe('memories')
    expect(
      extractBashSearchPattern('grep -rn "foo bar" ~/.freecode/memory'),
    ).toBe('foo bar')
    expect(extractBashSearchPattern("rg --glob '*.md' deploy /mem")).toBe(
      'deploy',
    )
  })

  test('rg/grep: -e value wins, later positionals are paths', () => {
    expect(extractBashSearchPattern("grep -e 'pat' dir")).toBe('pat')
    expect(extractBashSearchPattern("rg -e '-weird' dir")).toBe('-weird')
    expect(extractBashSearchPattern('rg --regexp alpha dir')).toBe('alpha')
  })

  test('value flags consume their argument', () => {
    expect(extractBashSearchPattern('rg -C3 -g !vendor pattern dir')).toBe(
      'pattern',
    )
    expect(extractBashSearchPattern('grep -m2 foo dir')).toBe('foo')
    expect(extractBashSearchPattern('rg --sort path query dir')).toBe('query')
    expect(extractBashSearchPattern('rg -- foo dir')).toBe('foo')
  })

  test('find: pattern comes from a pattern predicate', () => {
    expect(
      extractBashSearchPattern('find ~/.freecode/memory -name "*.md"'),
    ).toBe('*.md')
    expect(
      extractBashSearchPattern(
        'find /root -type f -regex ".*\\.jsonl" -delete',
      ),
    ).toBe('.*\\.jsonl')
  })

  test('pipes and chains share one pattern', () => {
    expect(extractBashSearchPattern('rg foo src | wc -l')).toBe('foo')
    expect(extractBashSearchPattern('cd /tmp && rg pat dir')).toBe('pat')
    expect(
      extractBashSearchPattern('rg memories /mem && rg memories /mem2'),
    ).toBe('memories')
  })

  test('ambiguous or unlabelable commands return undefined', () => {
    // Different patterns in different segments.
    expect(extractBashSearchPattern('rg foo a && rg bar b')).toBeUndefined()
    // Conflicting -e values.
    expect(extractBashSearchPattern('grep -e a -e b dir')).toBeUndefined()
    // find without a recognizable pattern predicate.
    expect(extractBashSearchPattern('find . -type f')).toBeUndefined()
    // Empty pattern.
    expect(extractBashSearchPattern('rg "" dir')).toBeUndefined()
    // Not a search command at all.
    expect(extractBashSearchPattern('which rg')).toBeUndefined()
    expect(extractBashSearchPattern('ls -la')).toBeUndefined()
    // Command substitution defeats static extraction.
    expect(extractBashSearchPattern('rg "$(cat p)" dir')).toBeUndefined()
  })
})
