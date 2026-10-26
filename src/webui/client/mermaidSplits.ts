/**
 * Splits transcript markdown into text and closed-mermaid-fence segments.
 *
 * `marked` cannot host mermaid: a renderer hook only sees the fence's opaque
 * token, and sanitized HTML has no svg/path whitelist entries. So the fences
 * are lifted out before markdown runs: every closed mermaid fence becomes a
 * `mermaid` segment (raw diagram source, minus the fence lines), everything
 * else stays in `text` segments that go through renderMarkdown unchanged.
 *
 * The line scanner is deliberately simple and streaming-safe:
 * - Only a CLOSED mermaid fence (opener plus a matching closer) becomes a
 *   diagram. Mid-stream an unclosed fence flushes its raw lines as text, so a
 *   half-received diagram renders as a plain code block until it closes —
 *   which is also what keeps mermaid from re-running on every delta.
 * - Any other fence (` ```ts `, ` ~~~ `) is tracked only so its body is never
 *   scanned for mermaid openers; the body is flushed verbatim.
 * - Fences may be indented up to 3 spaces, per CommonMark; a closer must use
 *   at least as many fence characters as its opener.
 */

export type MarkdownChunk =
  | { kind: 'text'; text: string }
  | { kind: 'mermaid'; source: string }

/** Opener: up to 3 spaces of indent, 3+ backticks or tildes, optional info string. */
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[ \t]*$/

interface OpenFence {
  mark: '~' | '`'
  length: number
  mermaid: boolean
  lines: string[]
}

function closerFor(fence: OpenFence): RegExp {
  const mark = fence.mark === '~' ? '~' : '`'
  return new RegExp(`^ {0,3}${mark}{${fence.length},}[ \\t]*$`)
}

export function splitMarkdownMermaid(text: string): MarkdownChunk[] {
  if (!text.includes('```') && !text.includes('~~~')) {
    // The common case: no fence characters at all, not even in flight.
    return [{ kind: 'text', text }]
  }

  const chunks: MarkdownChunk[] = []
  let buffer: string[] = []
  let open: OpenFence | null = null

  const flushText = (): void => {
    if (buffer.length) {
      chunks.push({ kind: 'text', text: buffer.join('\n') })
      buffer = []
    }
  }

  for (const line of text.split('\n')) {
    if (open) {
      if (closerFor(open).test(line)) {
        if (open.mermaid) {
          flushText()
          // lines[0] is the opener; the diagram source excludes the fences.
          chunks.push({
            kind: 'mermaid',
            source: open.lines.slice(1).join('\n'),
          })
        } else {
          // The fence stays verbatim, closer included.
          buffer.push(...open.lines, line)
        }
        open = null
      } else {
        open.lines.push(line)
      }
      continue
    }

    const match = FENCE_RE.exec(line)
    if (!match) {
      buffer.push(line)
      continue
    }
    const body = {
      mark: match[2]![0] as '~' | '`',
      mermaid: match[3]!.toLowerCase() === 'mermaid',
      lines: [line],
    }
    // A tilde fence cannot contain a backtick fence and vice versa, and the
    // body of a non-mermaid fence must be skipped whole.
    open = { ...body, length: match[2]!.length }
  }

  // An unclosed fence (mid-stream) is text like any other trailing content.
  if (open) buffer.push(...open.lines)
  flushText()
  return chunks
}
