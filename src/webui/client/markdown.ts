import { Marked } from 'marked'
import { FilterXSS } from 'xss'
import { mathExtension } from '../../utils/markedMath.js'
import { mathRenderExtension } from './mathRender.js'

/**
 * Transcript text is untrusted: it can contain a web page the agent fetched or
 * a file it read. Render markdown, then strip everything that could script.
 */
const filter = new FilterXSS({
  whiteList: {
    a: ['href', 'title'],
    b: [],
    blockquote: [],
    br: [],
    code: ['class'],
    del: [],
    em: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    hr: [],
    i: [],
    li: [],
    // Math placeholders (mathRender.ts) are the only span/div the transcript
    // ever contains, and the onTagAttr hook below pins their attributes to
    // exactly class="md-math" and data-display="0|1" — a model-authored
    // span/div can neither sneak a style through nor claim a math class.
    div: ['class', 'data-display'],
    ol: ['start'],
    p: [],
    pre: [],
    s: [],
    span: ['class', 'data-display'],
    strong: [],
    table: [],
    tbody: [],
    td: [],
    th: [],
    thead: [],
    tr: [],
    ul: [],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
  onTagAttr(tag, name, value) {
    if (tag === 'a' && name === 'href') {
      // javascript: and data: URLs are the obvious hole in an allowlist that
      // otherwise only permits anchors.
      const safe = /^(https?:|mailto:|#|\/)/i.test(value)
      return safe
        ? `href="${value}" rel="noreferrer noopener" target="_blank"`
        : 'href="#"'
    }
    if (tag === 'div' || tag === 'span') {
      // Returning '' drops the attribute. Only the exact placeholder pair
      // survives; anything else a model wrote degrades to a bare tag.
      if (name === 'class') return value === 'md-math' ? 'class="md-math"' : ''
      if (name === 'data-display')
        return value === '0' || value === '1' ? `data-display="${value}"` : ''
      return ''
    }
    return undefined
  },
})

/**
 * A private Marked instance rather than the global singleton: the TUI's
 * markdown module also configures global marked (and registers markedMath's
 * `<code>` fallback for the same `math` name), and the renderer registered
 * last wins the chain — the two consumers must not run each other's
 * renderers. Registering mathRenderExtension after mathExtension puts the
 * placeholder renderer ahead of the shared fallback; mathRender.ts's
 * MutationObserver does the real KaTeX typesetting once the CDN module
 * resolves.
 */
const md = new Marked({ gfm: true, breaks: true })
md.use({ extensions: [...mathExtension, mathRenderExtension] })

/**
 * Tables need a scroll container of their own: a bare table in a narrow
 * transcript row gets squeezed to the point of one-character-per-line cells.
 * The wrapper is applied after sanitizing — it is our own markup, so the div
 * does not need a whitelist entry and nothing the model wrote can sneak a
 * class through this way.
 */
const TABLE_RE = /<table(?:\s[^>]*)?>[\s\S]*?<\/table>/g

export function renderMarkdown(source: string): string {
  return filter
    .process(md.parse(source, { async: false }))
    .replace(TABLE_RE, table => `<div class="md-table">${table}</div>`)
}
