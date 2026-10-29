import type { RendererExtension } from 'marked'
import type { MathToken } from '../../utils/markedMath.js'

/**
 * Web-side rendering for `math` tokens from src/utils/markedMath.ts.
 *
 * Two pieces, mirroring the mermaid setup (components/Mermaid.tsx):
 *
 * 1. `mathRenderExtension` — a renderer registered on the math extension's
 *    name so marked chains it ahead of markedMath's `<code>` fallback. It does
 *    no typesetting: it emits a placeholder span/div whose text content is the
 *    HTML-escaped LaTeX source. Before (or without) KaTeX the transcript just
 *    shows the source, which is the same graceful degradation the TUI chose.
 *
 * 2. A typesetting pass — a MutationObserver that watches for placeholders
 *    entering the DOM and replaces their contents with KaTeX markup once the
 *    library resolves from a pinned CDN build. The observer covers every
 *    `.md` container without threading refs through components, and streaming
 *    falls out of the design: React's innerHTML swaps recreate the trailing
 *    chunk's placeholders unmarked, so grown sources re-typeset, while a chunk
 *    whose text stopped changing keeps its typeset markup untouched.
 */

/**
 * Pinned KaTeX version; the JS, the CSS, and the fonts they reference must
 * all be the same one. Matches the `katex` npm pin the TUI renderer uses so
 * both surfaces typeset a given source identically.
 */
export const KATEX_VERSION = '0.16.47'

// Typed `string` (not a literal) so the bundler keeps `import()` as a runtime
// import: Bun inlines literal specifiers into the bundle, and the bundled blob
// has no separate URL for the CDN fetch to ride under the page CSP.
const KATEX_MODULE_URL: string =
  'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.mjs'
const KATEX_CSS_URL: string =
  'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.css'

/** Class shared by inline and block placeholders; `data-display` tells them apart. */
export const MATH_CLASS = 'md-math'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Placeholder markup for a math token. Display math becomes a block div,
 * inline math a span; both carry only class + data-display, the two attributes
 * the transcript's FilterXSS whitelist makes room for.
 */
export function renderMathPlaceholder(token: MathToken): string {
  const body = escapeHtml(token.text ?? '')
  return token.displayMode
    ? `<div class="${MATH_CLASS}" data-display="1">${body}</div>`
    : `<span class="${MATH_CLASS}" data-display="0">${body}</span>`
}

/** Registered after markedMath's extensions so it wins the renderer chain. */
export const mathRenderExtension: RendererExtension = {
  name: 'math',
  renderer: token => renderMathPlaceholder(token as MathToken),
}

interface KatexModule {
  render(tex: string, el: HTMLElement, options?: Record<string, unknown>): void
}

let katexPromise: Promise<KatexModule> | null = null

function injectStylesheet(): void {
  if (document.head.querySelector('link[data-katex-css]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = KATEX_CSS_URL
  link.dataset.katexCss = '1'
  document.head.append(link)
}

function loadKaTeX(): Promise<KatexModule> {
  if (!katexPromise) {
    injectStylesheet()
    katexPromise = import(KATEX_MODULE_URL)
      .then(mod => {
        const katex = (mod as { default?: KatexModule } & Partial<KatexModule>)
          .default
        if (!katex?.render) throw new Error('katex module missing export')
        return katex
      })
      .catch(err => {
        // Let a later placeholder retry the fetch after a transient failure,
        // as the mermaid loader does.
        katexPromise = null
        throw err
      })
  }
  return katexPromise
}

/**
 * Replace one placeholder's source text with typeset markup. Synchronous: the
 * MutationObserver callback runs as a microtask, so the swap lands in the same
 * frame as the innerHTML rewrite that created the placeholder — no source-text
 * flash mid-stream.
 */
function typeset(katex: KatexModule, el: HTMLElement): void {
  const source = el.textContent ?? ''
  try {
    katex.render(source, el, {
      displayMode: el.dataset.display === '1',
      // Broken LaTeX shows the source with a red marker instead of throwing —
      // same philosophy as the TUI's fallback renderer.
      throwOnError: false,
    })
  } catch {
    el.removeAttribute('data-typeset')
  }
}

const PENDING_SELECTOR = `.${MATH_CLASS}:not([data-typeset])`

function collect(root: Element, into: HTMLElement[]): void {
  if (root instanceof HTMLElement && root.matches(PENDING_SELECTOR)) {
    into.push(root)
  }
  into.push(...root.querySelectorAll<HTMLElement>(PENDING_SELECTOR))
}

let started = false
const queue: HTMLElement[] = []

function drainQueue(): void {
  const pass = queue.splice(0)
  // Mark synchronously so a second batch in the same microtask does not queue
  // the same element twice while the first fetch is in flight.
  for (const el of pass) el.dataset.typeset = '1'
  if (!pass.length) return
  loadKaTeX().then(
    katex => {
      for (const el of pass) typeset(katex, el)
    },
    // Offline (LAN with no internet): the placeholders keep showing their
    // source; the next content change queues them again.
    () => {
      for (const el of pass) el.removeAttribute('data-typeset')
    },
  )
}

/**
 * Begin watching the document for math placeholders. Idempotent; call on the
 * first markdown render so content already in the DOM is picked up too.
 */
export function startMathTypesetting(): void {
  if (started || typeof document === 'undefined') return
  started = true
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) collect(node as Element, queue)
      }
    }
    drainQueue()
  }).observe(document.documentElement, { childList: true, subtree: true })
  document.querySelectorAll(PENDING_SELECTOR).forEach(el => collect(el, queue))
  drainQueue()
}
