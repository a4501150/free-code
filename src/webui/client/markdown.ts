import { marked } from 'marked'
import { FilterXSS } from 'xss'

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
    ol: ['start'],
    p: [],
    pre: [],
    s: [],
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
    return undefined
  },
})

marked.setOptions({ gfm: true, breaks: true })

export function renderMarkdown(source: string): string {
  return filter.process(marked.parse(source, { async: false }))
}
