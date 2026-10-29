import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { renderMarkdown } from '../../src/webui/client/markdown.js'
import {
  KATEX_VERSION,
  MATH_CLASS,
  renderMathPlaceholder,
} from '../../src/webui/client/mathRender.js'

/**
 * Placeholder/sanitize layer tests — pure string-level, no DOM. The KaTeX
 * typesetting pass (mathRender.ts's MutationObserver) needs a browser; the
 * invariant these tests pin is that everything reaching the DOM is either
 * sanitized transcript HTML or an inert `.md-math` placeholder carrying its
 * escaped source, which is what the observer consumes.
 */

describe('webui math placeholders', () => {
  test('inline math becomes a span carrying the source', () => {
    const html = renderMarkdown('the value $x^2$ grows')
    expect(html).toContain(`<span class="${MATH_CLASS}" data-display="0">`)
    expect(html).toContain('x^2')
    expect(html).not.toContain('<code>') // beat markedMath's fallback
  })

  test('display math becomes a block div', () => {
    const html = renderMarkdown('$$\n\\frac{a}{b}\n$$')
    expect(html).toContain(`<div class="${MATH_CLASS}" data-display="1">`)
    expect(html).toContain('\\frac{a}{b}')
  })

  test('placeholder output escapes HTML metacharacters in the source', () => {
    const html = renderMathPlaceholder({
      type: 'math',
      raw: '',
      text: 'a < b & c > d',
      displayMode: false,
    })
    expect(html).toBe(
      '<span class="md-math" data-display="0">a &lt; b &amp; c &gt; d</span>',
    )
  })

  test('escaping survives the sanitizer end to end', () => {
    const html = renderMarkdown('a $b < c$ d')
    expect(html).toContain('b &lt; c')
    expect(html).not.toContain('b < c')
  })

  test('an unclosed $$ mid-stream still yields a growing placeholder', () => {
    const html = renderMarkdown('prefix\n\n$$\nx = 1 + ')
    expect(html).toContain(`<div class="${MATH_CLASS}" data-display="1">`)
    expect(html).toContain('x = 1 +')
  })

  test('math inside a list item renders a placeholder', () => {
    const html = renderMarkdown('- $E=mc^2$\n- plain')
    expect(html).toContain(`<span class="${MATH_CLASS}" data-display="0">`)
  })

  test('currency text produces no placeholder', () => {
    const html = renderMarkdown('it costs $5 and $10 total')
    expect(html).not.toContain(MATH_CLASS)
  })
})

describe('span/div whitelist delta', () => {
  test('model-authored span attributes are stripped', () => {
    const html = renderMarkdown(
      'x <span style="color:red" onclick="alert(1)">hi</span> y',
    )
    expect(html).not.toContain('style=')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('alert(1)')
    // The text inside survives; only the attributes (and the now-harmless
    // wrapper) come through.
    expect(html).toContain('hi')
  })

  test('a model-authored div cannot claim the math class or a display flag', () => {
    const html = renderMarkdown('<div class="x" data-display="9">c</div>')
    expect(html).not.toContain('class="x"')
    expect(html).not.toContain('data-display')
    expect(html).toContain('>c<')
  })

  test('model-authored inline script body is dropped', () => {
    const html = renderMarkdown('before <script>alert(1)</script> after')
    expect(html).not.toContain('alert')
    expect(html).not.toContain('<script')
  })
})

describe('pinned katex version', () => {
  test('version is a pinned 0.x patch release', () => {
    expect(KATEX_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('the built bundle keeps the CDN URLs as runtime strings', () => {
    // Same guard as the mermaid wiring test: a fresh checkout with no WEBUI
    // build has no generated module, and the KaTeX library itself must stay
    // out of the bundle (it is fetched only when math is on screen).
    const assetsPath = join(
      import.meta.dir,
      '..',
      '..',
      'src/webui/generated/assets.ts',
    )
    if (!existsSync(assetsPath)) return
    const js = readFileSync(assetsPath, 'utf8')
    expect(js).toContain(
      `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.mjs`,
    )
    expect(js).toContain(
      `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`,
    )
    // KaTeX internals must not be inlined: the module has to stay a CDN fetch.
    expect(js).not.toContain('KaTeX_Main')
  })
})
