import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from '../markdown.js'
import { startMathTypesetting } from '../mathRender.js'
import { splitMarkdownMermaid } from '../mermaidSplits.js'
import { Mermaid } from './Mermaid.js'

/**
 * Renders assistant markdown into a `.md` container: sanitized HTML for text,
 * live diagrams for closed mermaid fences.
 *
 * Streaming-safe by construction — text chunks are plain `dangerouslySetInnerHTML`
 * divs keyed by position, so a delta rewrites only the changed div's innerHTML
 * (React skips the write entirely for a chunk whose HTML string is unchanged,
 * keeping that subtree — typeset math included — untouched). A mermaid chunk's
 * key encodes the diagram source, so a diagram that stops growing keeps its
 * subtree (and its rendered SVG) through further deltas.
 *
 * Math arrives inside the sanitized text chunks as `.md-math` placeholders
 * holding the LaTeX source; the observer in mathRender.ts typesets them with
 * lazily-loaded KaTeX, so no ref plumbing is needed here — starting the
 * observer once, on the first markdown render, covers every `.md` container.
 */
export function MarkdownBody({ text }: { text: string }): React.ReactElement {
  useEffect(() => startMathTypesetting(), [])
  const chunks = useMemo(() => splitMarkdownMermaid(text), [text])
  return (
    <>
      {chunks.map((chunk, i) =>
        chunk.kind === 'mermaid' ? (
          <Mermaid
            key={`m${i}:${chunk.source.length}:${hash(chunk.source)}`}
            source={chunk.source}
          />
        ) : (
          <TextChunk key={`t${i}`} text={chunk.text} />
        ),
      )}
    </>
  )
}

/** Horizontal scrollers embedded in sanitized markdown: table wrappers and
 *  code blocks. Both need their position kept across a chunk's innerHTML swap. */
const SCROLLERS = '.md-table, pre'

/**
 * One sanitized-HTML text chunk.
 *
 * While the message streams, every delta re-sets this div's innerHTML, which
 * recreates all descendants — the `.md-table` a reader is mid-swipe on
 * included, snapping its scrollLeft back to 0. Two halves keep the position:
 * the key above deliberately does NOT encode the text length, so the div (and
 * this component's saved positions) survives a delta instead of remounting;
 * and the layout effect below restores each scroller's scrollLeft, matched by
 * document order — streaming only appends, so the order of scrollers that
 * already rendered is stable — after the swap, before paint.
 */
const TextChunk = memo(function TextChunk({
  text,
}: {
  text: string
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const lefts = useRef<number[]>([])
  const html = useMemo(() => renderMarkdown(text), [text])

  // scroll does not bubble, but its capture phase still descends through this
  // div — the listener is the only moment a swipe between two commits is seen.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const at = Array.prototype.indexOf.call(
        el.querySelectorAll<HTMLElement>(SCROLLERS),
        target,
      )
      if (at >= 0) lefts.current[at] = target.scrollLeft
    }
    el.addEventListener('scroll', onScroll, true)
    return () => el.removeEventListener('scroll', onScroll, true)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.querySelectorAll<HTMLElement>(SCROLLERS).forEach((scroller, i) => {
      const left = lefts.current[i]
      if (left !== undefined && scroller.scrollLeft !== left) {
        scroller.scrollLeft = left
      }
    })
  })

  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
})

function hash(text: string): string {
  // Enough to make a changed diagram remount; collisions only cost a re-render.
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
