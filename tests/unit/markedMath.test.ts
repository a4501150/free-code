import { describe, expect, test } from 'bun:test'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import {
  applyMarkdown,
  configureMarked,
  isClosedMathBlock,
} from '../../src/utils/markdown.js'

configureMarked()

function render(content: string): string {
  return stripAnsi(applyMarkdown(content, 'dark', null))
}

interface MathToken {
  type: 'math'
  text: string
  raw: string
  displayMode: boolean
}

function mathTokens(content: string): MathToken[] {
  return marked
    .lexer(content)
    .filter(
      (t): t is Token & MathToken => t.type === 'math',
    ) as unknown as MathToken[]
}

function allMathTokens(tokens: Token[]): MathToken[] {
  const out: MathToken[] = []
  const walk = (ts: Token[]): void => {
    for (const t of ts) {
      if (t.type === 'math') out.push(t as unknown as MathToken)
      const children = (t as { tokens?: Token[] }).tokens
      if (children) walk(children)
      const table = t as Partial<Tokens.Table>
      if (table.header) {
        for (const cell of table.header) walk(cell.tokens ?? [])
        for (const row of table.rows ?? [])
          for (const cell of row) walk(cell.tokens ?? [])
      }
    }
  }
  walk(tokens)
  return out
}

describe('block math ($$ fences and \\[…\\])', () => {
  test('closed $$ block yields a top-level math token with displayMode true', () => {
    const tokens = mathTokens('Intro\n\n$$\nx^2 + y^2 = z^2\n$$\n\nafter')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.displayMode).toBe(true)
    expect(tokens[0]!.text).toBe('x^2 + y^2 = z^2')
    // Delimiters excluded from text, present in raw.
    expect(tokens[0]!.raw).toContain('$$')
  })

  test('closed $$ block renders a dim latex hint above the source, delimiters dropped', () => {
    const out = render('Intro\n\n$$\nx^2 + y^2 = z^2\n$$\n\nafter')
    expect(out).toContain('latex')
    expect(out).toContain('x^2 + y^2 = z^2')
    expect(out).not.toContain('$$')
    // Hint sits above the body; surrounding content intact.
    expect(out.indexOf('latex')).toBeLessThan(out.indexOf('x^2'))
    expect(out).toContain('Intro')
    expect(out).toContain('after')
  })

  test('\\[…\\] block renders the same treatment', () => {
    const tokens = mathTokens('\\[\n\\int_0^1 x\\,dx\n\\]')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.displayMode).toBe(true)
    expect(tokens[0]!.text).toBe('\\int_0^1 x\\,dx')
    const out = render('\\[\n\\int_0^1 x\\,dx\n\\]')
    expect(out).toContain('latex')
    expect(out).toContain('\\int_0^1 x\\,dx')
    expect(out).not.toContain('\\[')
  })

  test('single-line $$x$$ renders as display math', () => {
    const out = render('Text\n\n$$x^2$$\n\nmore')
    expect(out).toContain('latex')
    expect(out).toContain('x^2')
    expect(out).not.toContain('$$')
  })

  test('$$ interrupts a paragraph', () => {
    const tokens = mathTokens('para text\n$$\na+b\n$$')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.displayMode).toBe(true)
    // The paragraph stopped before the opener.
    const paras = marked
      .lexer('para text\n$$\na+b\n$$')
      .filter(t => t.type === 'paragraph')
    expect(paras[0]!.raw.trim()).toBe('para text')
  })

  test('unclosed $$ mid-stream renders raw source, no hint', () => {
    const out = render('Intro\n\n$$\n\\int x dx')
    expect(out).not.toContain('latex')
    // Raw source (opener included) grows as plain text while streaming.
    expect(out).toContain('$$')
    expect(out).toContain('\\int x dx')
  })

  test('isClosedMathBlock distinguishes closed from streaming blocks', () => {
    const [closed] = mathTokens('$$\nx\n$$')
    const [unclosed] = mathTokens('$$\nx')
    expect(closed).toBeDefined()
    expect(unclosed).toBeDefined()
    expect(isClosedMathBlock(closed as unknown as Token)).toBe(true)
    expect(isClosedMathBlock(unclosed as unknown as Token)).toBe(false)
    const [closedBracket] = mathTokens('\\[\nx\n\\]')
    expect(isClosedMathBlock(closedBracket as unknown as Token)).toBe(true)
  })
})

describe('inline math ($…$ and \\(…\\))', () => {
  test('inline $…$ yields displayMode false', () => {
    const tokens = marked.lexer('Inline $\\alpha + \\beta$ here')
    const math = allMathTokens(tokens)
    expect(math).toHaveLength(1)
    expect(math[0]!.displayMode).toBe(false)
    expect(math[0]!.text).toBe('\\alpha + \\beta')
    const out = render('Inline $\\alpha + \\beta$ here')
    // Codespan-style: source without delimiters, flanked by plain text.
    expect(out).toBe('Inline \\alpha + \\beta here')
  })

  test('inline \\(…\\) yields displayMode false', () => {
    const tokens = marked.lexer('text \\(a+b\\) tail')
    const math = allMathTokens(tokens)
    expect(math).toHaveLength(1)
    expect(math[0]!.displayMode).toBe(false)
    expect(math[0]!.text).toBe('a+b')
    expect(render('text \\(a+b\\) tail')).toBe('text a+b tail')
  })

  test('single-line $$…$$ inside a paragraph is display math', () => {
    const tokens = marked.lexer('see $$\\frac{a}{b}$$ inline')
    const math = allMathTokens(tokens)
    expect(math).toHaveLength(1)
    expect(math[0]!.displayMode).toBe(true)
    expect(render('see $$\\frac{a}{b}$$ inline')).toContain('\\frac{a}{b}')
  })

  test('math renders inside a paragraph sentence', () => {
    expect(render('energy $e=mc^2$ is conserved')).toBe(
      'energy e=mc^2 is conserved',
    )
  })

  test('math renders inside a list item', () => {
    expect(render('- item with $x_i$ math\n- plain')).toBe(
      '- item with x_i math\n- plain',
    )
  })

  test('math adjacent to punctuation keeps the punctuation', () => {
    expect(render('see ($x^2$), ok?')).toBe('see (x^2), ok?')
  })
})

describe('currency and escape false-positive guards', () => {
  test('"costs $5 and $10 — total $15" stays plain text', () => {
    const content = 'costs $5 and $10 — total $15'
    expect(allMathTokens(marked.lexer(content))).toHaveLength(0)
    expect(render(content)).toBe(content)
  })

  test('closer followed by a digit does not match ($x$10 stays text)', () => {
    const content = 'ratio $x$10 is wrong'
    expect(allMathTokens(marked.lexer(content))).toHaveLength(0)
    expect(render(content)).toBe(content)
  })

  test('closer preceded by whitespace does not match ($x $ stays text)', () => {
    const content = 'pay $5 now or $ 10 later'
    expect(allMathTokens(marked.lexer(content))).toHaveLength(0)
    expect(render(content)).toBe(content)
  })

  test('escaped \\$ renders as a literal dollar, no math token', () => {
    expect(render('cost \\$5')).toBe('cost $5')
    expect(allMathTokens(marked.lexer('cost \\$5 and $x$'))).toHaveLength(1)
  })

  test('single $ with no closer falls through to text', () => {
    const content = 'has a lone $ sign here'
    expect(allMathTokens(marked.lexer(content))).toHaveLength(0)
    expect(render(content)).toBe(content)
  })
})

describe('math inside table cells', () => {
  test('escaped-pipe math in a cell lexes as a math token and renders', () => {
    const out = render('| a | b |\n|---|---|\n| $a\\|b$ | x |\n')
    expect(out).toContain('a|b')
    expect(out).not.toContain('$')
    const table = marked.lexer('| a | b |\n|---|---|\n| $a\\|b$ | x |\n')[0] as
      | Tokens.Table
      | undefined
    expect(table?.type).toBe('table')
    const math = allMathTokens([table!])
    expect(math).toHaveLength(1)
    expect(math[0]!.text).toBe('a|b')
  })

  test('raw (unescaped) | inside $…$ in a cell still splits the cell — documented marked behavior', () => {
    // Cell splitting happens on the raw line before any inline lexing, so a
    // bare | in math splits the row regardless of the extension. No crash;
    // the `$` fragments render as literal text.
    const out = render('| col | val |\n|---|---|\n| $a|b$ | x |\n')
    expect(out).toContain('$a')
    expect(out).toContain('b$')
    expect(
      allMathTokens(marked.lexer('| col | val |\n|---|---|\n| $a|b$ | x |\n')),
    ).toHaveLength(0)
  })
})
