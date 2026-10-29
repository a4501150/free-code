import { useEffect, useMemo } from 'react'
import { renderMarkdown } from '../markdown.js'
import { startMathTypesetting } from '../mathRender.js'
import { splitMarkdownMermaid } from '../mermaidSplits.js'
import { Mermaid } from './Mermaid.js'

/**
 * Renders assistant markdown into a `.md` container: sanitized HTML for text,
 * live diagrams for closed mermaid fences.
 *
 * Streaming-safe by construction — text chunks are plain `dangerouslySetInnerHTML`
 * divs and a chunk's key encodes its content length, so appending to the
 * trailing chunk during a stream re-renders only that div's innerHTML. A
 * mermaid chunk's key encodes the diagram source, so a diagram that stops
 * growing keeps its subtree (and its rendered SVG) through further deltas.
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
          <div
            key={`t${i}:${chunk.text.length}`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(chunk.text) }}
          />
        ),
      )}
    </>
  )
}

function hash(text: string): string {
  // Enough to make a changed diagram remount; collisions only cost a re-render.
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
