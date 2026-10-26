import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { applyMarkdown } from '../../src/utils/markdown.js'

const HINT = 'mermaid diagram (renders in the WebUI)'

function render(content: string): string {
  return stripAnsi(applyMarkdown(content, 'dark', null))
}

describe('mermaid fence rendering', () => {
  test('closed mermaid fence renders the diagram hint above the body', () => {
    const out = render('Intro\n\n```mermaid\ngraph TD; A-->B;\n```\n\nafter')
    expect(out).toContain(HINT)
    expect(out).toContain('graph TD; A-->B;')
    // The fence itself is replaced by the treatment, not shown raw.
    expect(out).not.toContain('```')
    // Hint sits above the body, and surrounding content is intact.
    expect(out.indexOf(HINT)).toBeLessThan(out.indexOf('graph TD'))
    expect(out).toContain('Intro')
    expect(out).toContain('after')
  })

  test('fence language is matched case-insensitively', () => {
    expect(render('```Mermaid\ngraph TD;\n```')).toContain(HINT)
  })

  test('unclosed mermaid fence (mid-stream) renders as a plain code block', () => {
    const out = render('Intro\n\n```mermaid\ngraph TD; A-->')
    expect(out).not.toContain(HINT)
    expect(out).toContain('graph TD; A-->')
  })

  test('bare opening fence mid-stream does not crash or show the hint', () => {
    const out = render('Intro\n\n```mer')
    expect(out).not.toContain(HINT)
  })

  test('non-mermaid code blocks are unaffected', () => {
    const out = render('```ts\nconst x = 1\n```')
    expect(out).not.toContain(HINT)
    expect(out).toContain('const x = 1')
  })

  test('mermaid body containing backtick-ish content still closes cleanly', () => {
    const out = render('```mermaid\nA["code `x`"] --> B\n```')
    expect(out).toContain(HINT)
    expect(out).toContain('A["code `x`"] --> B')
  })
})
