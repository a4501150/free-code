import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import {
  __mathGridLayoutCacheSize,
  renderMathGrid,
} from '../../src/utils/latexAnsi.ts'
import { applyMarkdown, configureMarked } from '../../src/utils/markdown.ts'

configureMarked()

/** Strip styling and wrap each row so trailing spaces stay visible-ish. */
function grid(latex: string, maxWidth = 80): string {
  const out = renderMathGrid(latex, 'dark', { maxWidth })
  expect(out).not.toBeNull()
  return stripAnsi(out!)
}

function rows(latex: string, maxWidth = 80): string[] {
  return grid(latex, maxWidth).split('\n')
}

describe('2D layout — goldens', () => {
  test('fraction: numerator / bar / denominator', () => {
    expect(rows('\\frac{1}{2}')).toEqual(['1', '─', '2'])
  })

  test('nested fraction stacks recursively', () => {
    const r = rows('\\frac{\\frac{a}{b}+1}{c-\\frac{d}{e}}')
    // Outer bar (a full-width rule row) sits between the two children.
    const barRow = r.findIndex(l => /^─+$/.test(l))
    expect(barRow).toBe(3)
    expect(r.length).toBe(7)
    // Three bars total: the outer one plus one inside each child.
    expect(r.filter(l => l.includes('─'))).toHaveLength(3)
  })

  test('superscript moves above the baseline row', () => {
    const r = rows('x^2')
    expect(r).toEqual([' 2', 'x '])
  })

  test('sub+super on one atom stack side-by-side rows', () => {
    const r = rows('x_i^2')
    expect(r).toEqual([' 2', 'x ', ' i'])
  })

  test('sqrt: radical with overline run', () => {
    const r = rows('\\sqrt{x}')
    expect(r[0]).toBe('√──')
    expect(r[1]).toBe('  x')
  })

  test('sqrt with index puts the index above the radical', () => {
    const r = rows('\\sqrt[3]{x+1}')
    expect(r[0]!.trim()).toBe('3')
    expect(r[1]!.startsWith('√─')).toBe(true)
    expect(r[2]).toContain('x + 1')
  })

  test('display sum carries limits above and below', () => {
    const r = rows('\\sum_{i=1}^{n} i')
    expect(r).toEqual([' n  ', ' ∑ i', 'i=1 '])
  })

  test('integral keeps limits as trailing scripts', () => {
    const r = rows('\\int_0^1 x\\,dx')
    expect(r[1]!.startsWith('∫')).toBe(true)
    expect(r[0]).toContain('1')
    expect(r[2]).toContain('0')
    // \, renders as one space cell between x and dx.
    expect(r[1]).toContain('x dx')
  })

  test('\\hat draws a hat in the row above the base', () => {
    expect(rows('\\hat{x}')).toEqual(['^', 'x'])
  })

  test('\\overline draws a rule row above the base', () => {
    expect(rows('\\overline{AB}')).toEqual(['──', 'AB'])
  })

  test('pmatrix stretches round delimiters to the grid height', () => {
    // 2-row grid uses plain parens (sizes 1-2 stay plain).
    expect(rows('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')).toEqual([
      '(a b)',
      '(c d)',
    ])
  })

  test('bmatrix 3x3 uses stretched square brackets', () => {
    const r = rows(
      '\\begin{bmatrix} 1 & 2 & 3 \\\\ 4 & 5 & 6 \\\\ 7 & 8 & 9 \\end{bmatrix}',
    )
    expect(r).toEqual(['⎡1 2 3⎤', '⎢4 5 6⎥', '⎣7 8 9⎦'])
  })

  test('vmatrix determinant: plain bars on a 2-row grid', () => {
    const r = rows('A = \\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}')
    expect(r[0]).toContain('|a b|')
    expect(r[1]).toContain('|c d|')
    expect(r[1]!.startsWith('A')).toBe(true) // baseline-aligned with A
  })

  test('cases: one stretched left brace, column gap', () => {
    const r = rows(
      '\\begin{cases} x & x>0 \\\\ -x & x<0 \\\\ 0 & x=0 \\end{cases}',
    )
    expect(r.length).toBe(3)
    expect(r[0]![0]).toBe('⎧')
    expect(r[1]![0]).toBe('⎪')
    expect(r[2]![0]).toBe('⎩')
    expect(r[0]).toContain('x>0')
  })

  test('aligned: r|l column alignment from the array spec', () => {
    const r = rows('\\begin{aligned} a &= b \\\\ c &= d+e \\end{aligned}')
    expect(r).toEqual(['a =b    ', 'c =d + e'])
  })

  test('\\binom renders delimiter-framed no-bar frac', () => {
    expect(rows('\\binom{5}{2}')).toEqual(['(5)', '(2)'])
  })

  test('\\text renders verbatim amid math', () => {
    const r = rows('E = mc^2 \\text{ and } \\alpha')
    expect(r[1]).toContain('and')
    expect(r[1]).toContain('α')
  })

  test('quadratic formula: bar spans the numerator, x= on the bar row', () => {
    const r = rows('x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}')
    // The fraction-bar row is the math axis — 'x=' aligns on it.
    const barRow = r.findIndex(l => l.startsWith('x='))
    expect(barRow).toBeGreaterThan(0)
    // The bar spans at least the widest child (the -b±√… numerator).
    const barSpan = r[barRow]!.lastIndexOf('─') - r[barRow]!.indexOf('─') + 1
    expect(barSpan).toBeGreaterThanOrEqual(15)
    // Radical + its overline sit on a row above the bar.
    expect(r.some(l => l.includes('√─'))).toBe(true)
  })

  test('\\left( \\right) stretches across 3+ rows', () => {
    const r = rows(
      '\\left( \\begin{matrix} 1 \\\\ 2 \\\\ 3 \\end{matrix} \\right)',
    )
    expect(r).toEqual(['⎛1⎞', '⎜2⎟', '⎝3⎠'])
  })
})

describe('degradation', () => {
  test('level 1: parse error → layouter returns null', () => {
    expect(renderMathGrid('\\frac{1}', 'dark')).toBeNull()
    expect(renderMathGrid('\\begin{matrix} 1', 'dark')).toBeNull()
  })

  test('level 1: formatToken falls back to the byte-identical dim rail', () => {
    const rail = applyMarkdown('$$\n\\frac{1}\n$$', 'dark', null)
    const plain = stripAnsi(rail)
    expect(plain).toContain('latex')
    expect(plain).toContain('\\frac{1}')
    expect(plain).toContain('│')
  })

  test('level 2: unsupported command that parses degrades, never throws', () => {
    // \includegraphics parses (KaTeX treats it as a text-ish group); the
    // layouter must return *something* rather than throw.
    const out = renderMathGrid('\\includegraphics{fig}', 'dark')
    expect(out).not.toBeNull()
    expect(out!.length).toBeGreaterThan(0)
  })

  test('level 3: grid wider than maxWidth → null (rail fallback)', () => {
    const wide =
      '\\begin{bmatrix} 111111 & 222222 & 333333 \\\\ 444444 & 555555 & 666666 \\end{bmatrix}'
    expect(renderMathGrid(wide, 'dark', { maxWidth: 20 })).toBeNull()
    // Same matrix fits in a wider terminal.
    expect(renderMathGrid(wide, 'dark', { maxWidth: 80 })).not.toBeNull()
  })

  test('inline math keeps the codespan treatment', () => {
    const out = applyMarkdown('text $x_i$ tail', 'dark', null)
    expect(stripAnsi(out)).toBe('text x_i tail')
  })

  test('unclosed display block still streams as dim raw', () => {
    const out = applyMarkdown('$$\n\\frac{1}{2}', 'dark', null)
    expect(stripAnsi(out)).toContain('$$')
    expect(stripAnsi(out)).toContain('\\frac{1}{2}')
  })
})

describe('cache', () => {
  test('LRU stays bounded under many distinct layouts', () => {
    for (let i = 0; i < 250; i++) {
      expect(renderMathGrid(`x_{${i}}`, 'dark')).not.toBeNull()
    }
    expect(__mathGridLayoutCacheSize()).toBeLessThanOrEqual(200)
  })
})
