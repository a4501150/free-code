import type { TokenizerAndRendererExtension, Tokens } from 'marked'

/**
 * LaTeX math tokenization for shared marked setups (TUI and, in a later
 * phase, the webui client bundle).
 *
 * Browser-safe: no Node APIs, no React, no rendering dependencies. Only
 * produces `math` tokens — consumers decide how to display them (the TUI
 * uses `formatToken`; the webui will register its own renderer later).
 *
 * Token shape:
 *   type: 'math'
 *   text:        raw LaTeX source, delimiters excluded
 *   displayMode: true for block math ($$...$$, \[...\]), false for inline
 *   raw:         the consumed source, delimiters included
 *
 * Streaming note: an unclosed block opener still produces a token (raw runs
 * to end of input) so consumers can render growing plain source; check
 * closedness from `raw` (see `isClosedMathBlock` in markdown.ts).
 */

export interface MathToken extends Tokens.Generic {
  type: 'math'
  text: string
  displayMode: boolean
}

// Block closers must sit on their own line (fence-like), which also keeps a
// stray `$$` mid-sentence from closing a block early.
const BLOCK_CLOSE_DOLLAR = /^\s*\$\$\s*$/
const BLOCK_CLOSE_BRACKET = /^\s*\\\]\s*$/

// Inline `$...$` with currency false-positive guards:
//  - opener `$` may not be followed by whitespace or a digit ("$5 and $10"
//    stays text);
//  - closer `$` may not be preceded by whitespace nor followed by a digit;
//  - content excludes a bare `$` (no nesting) and newlines (single-line
//    matches only), but allows `\x` escape pairs so `\$` cannot terminate
//    the match;
//  - a lone `$` with no closer matches nothing → undefined → text.
const INLINE_DOLLAR =
  /^\$(?![\s\d])((?:[^\\$\n]|\\[\s\S])+?)(?<![\s\\])\$(?!\d)/
const INLINE_DISPLAY = /^\$\$([\s\S]*?)\$\$/
const INLINE_BRACKET = /^\\\(([\s\S]*?)\\\)/

function tokenizeMathBlock(src: string): MathToken | undefined {
  const dollar = src.startsWith('$$')
  if (!dollar && !src.startsWith('\\[')) return undefined
  const closer = dollar ? BLOCK_CLOSE_DOLLAR : BLOCK_CLOSE_BRACKET
  const closeTail = dollar ? '$$' : '\\]'
  const lines = src.split('\n')
  const openRest = lines[0]!.slice(2)

  // Single-line form: `$$x$$` / `\[x\]` with both delimiters on the opener.
  if (openRest.length > closeTail.length && openRest.endsWith(closeTail)) {
    return {
      type: 'math',
      raw: lines[0]!,
      text: openRest.slice(0, -closeTail.length).trim(),
      displayMode: true,
    }
  }

  for (let i = 1; i < lines.length; i++) {
    if (closer.test(lines[i]!)) {
      return {
        type: 'math',
        raw: lines.slice(0, i + 1).join('\n'),
        text: [openRest, ...lines.slice(1, i)].join('\n').trim(),
        displayMode: true,
      }
    }
  }

  // Unclosed (mid-stream): consume the rest so the consumer can render the
  // still-growing source instead of leaking it back as markdown text.
  return {
    type: 'math',
    raw: src,
    text: [openRest, ...lines.slice(1)].join('\n').trim(),
    displayMode: true,
  }
}

function tokenizeMathInline(src: string): MathToken | undefined {
  if (src.startsWith('$$')) {
    const cap = INLINE_DISPLAY.exec(src)
    if (cap) {
      return {
        type: 'math',
        raw: cap[0],
        text: cap[1]!.trim(),
        displayMode: true,
      }
    }
    // Unclosed `$$` mid-line while streaming — grow as display source.
    return {
      type: 'math',
      raw: src,
      text: src.slice(2).trim(),
      displayMode: true,
    }
  }
  if (src.startsWith('\\(')) {
    const cap = INLINE_BRACKET.exec(src)
    if (!cap) return undefined
    return {
      type: 'math',
      raw: cap[0],
      text: cap[1]!.trim(),
      displayMode: false,
    }
  }
  const cap = INLINE_DOLLAR.exec(src)
  if (!cap) return undefined
  return { type: 'math', raw: cap[0], text: cap[1]!, displayMode: false }
}

// Fallback renderer so a plain `marked.parse()` never throws on a math
// token. Real consumers (TUI formatToken, webui KaTeX renderer) bypass or
// override this — a later registered renderer for the same name runs first.
function mathFallbackRenderer(token: Tokens.Generic): string {
  const text = escapeHtml((token as MathToken).text ?? '')
  const code = `<code>${text}</code>`
  return (token as MathToken).displayMode ? `<p>${code}</p>` : code
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Block-level `$$…$$` / `\[…\]` math. */
export const mathBlockExtension: TokenizerAndRendererExtension = {
  name: 'math',
  level: 'block',
  // Enables `$$` / `\[` to interrupt a paragraph.
  start(src: string) {
    return src.match(/^\$\$|^\\\[/m)?.index
  },
  tokenizer: tokenizeMathBlock,
  renderer: mathFallbackRenderer,
}

/** Inline `$…$` / `\(…\)` math (and single-line `$$…$$` inside a paragraph). */
export const mathInlineExtension: TokenizerAndRendererExtension = {
  name: 'math',
  level: 'inline',
  start(src: string) {
    return src.match(/\$|\\\(/)?.index
  },
  tokenizer: tokenizeMathInline,
}

/** Both math extensions, ready for `marked.use({ extensions: mathExtension })`. */
export const mathExtension: TokenizerAndRendererExtension[] = [
  mathBlockExtension,
  mathInlineExtension,
]
