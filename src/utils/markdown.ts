import chalk from 'chalk'
import { marked, Marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '../components/design-system/color.js'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from './debug.js'
import { createHyperlink } from './hyperlink.js'
import { mathExtension } from './markedMath.js'
import { stripPromptXMLTags } from './messages.js'
import { renderMathGrid } from './latexAnsi.js'
import type { ThemeName } from './theme.js'

// Use \n unconditionally — os.EOL is \r\n on Windows, and the extra \r
// breaks the character-to-segment mapping in applyStylesToWrappedText,
// causing styled text to shift right.
const EOL = '\n'

let markedConfigured = false

// Separate instance with no extensions: its lexer is the untouched default
// used to (re)parse source inside the tokenizer override below.
const defaultMarked = new Marked()

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true

  // LaTeX math tokens (type 'math') for both instances — the table tokenizer
  // below re-lexes through defaultMarked, so cells need the extension too.
  marked.use({ extensions: mathExtension })
  defaultMarked.use({ extensions: mathExtension })

  // Disable strikethrough parsing - the model often uses ~ for "approximate"
  // (e.g., ~100) and rarely intends actual strikethrough formatting
  marked.use({
    tokenizer: {
      del() {
        return undefined
      },
      // A raw `|` inside a code span in a table cell (`| tail` in backticks)
      // splits the row into more cells than the delimiter row declares, so
      // GFM rejects the table and the user sees the raw markdown block.
      // GFM's answer is `\|`, which models rarely write — rewrite it on the
      // way into the default table rule.
      table(src) {
        return defaultMarked.lexer(escapePipesInTable(src))[0] as
          | Tokens.Table
          | undefined
      },
    },
  })
}

const TABLE_PIPE_SPAN = /(`+)([^`]*?)\1/g
const TABLE_ROW = /^\s*\|/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/**
 * Escape `|` as `\|` inside code spans on the table-block lines of `src` so
 * the default GFM table rule sees a well-formed block; the cell inline lexer
 * turns `\|` back into a literal `|`. Only touches lines of a block with a
 * delimiter row, so anything the default rule would not have called a table
 * passes through unchanged.
 */
export function escapePipesInTable(src: string): string {
  const lines = src.split(EOL)
  let headerEnd = -1
  for (let i = 0; i + 1 < lines.length; i++) {
    if (TABLE_ROW.test(lines[i]!) && TABLE_DELIMITER.test(lines[i + 1]!)) {
      headerEnd = i + 1
      break
    }
  }
  if (headerEnd === -1) return src
  let bodyEnd = headerEnd + 1
  while (bodyEnd < lines.length && TABLE_ROW.test(lines[bodyEnd]!)) bodyEnd++
  for (let i = 0; i < bodyEnd; i++) {
    if (!TABLE_ROW.test(lines[i]!)) continue
    lines[i] = lines[i]!.replace(
      TABLE_PIPE_SPAN,
      (span, fence: string, inside: string) =>
        inside.includes('\\|')
          ? span
          : fence + inside.replace(/\|/g, '\\|') + fence,
    )
  }
  return lines.join(EOL)
}

export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  return marked
    .lexer(stripPromptXMLTags(content))
    .map(_ => formatToken(_, theme, 0, null, null, highlight))
    .join('')
    .trim()
}

export function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, null, highlight))
        .join('')
      // Prefix each line with a dim vertical bar. Keep text italic but at
      // normal brightness — chalk.dim is nearly invisible on dark themes.
      const bar = chalk.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map(line =>
          stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line,
        )
        .join(EOL)
    }
    case 'code': {
      // Mermaid blocks get a dim hint instead of highlighting — the TUI has no
      // layout engine, the WebUI renders the real diagram. Only once the
      // closing fence has been seen; while streaming an unclosed fence falls
      // through to the normal code path.
      if (token.lang?.toLowerCase() === 'mermaid' && isClosedCodeFence(token)) {
        return formatMermaidDiagram(token.text)
      }
      if (!highlight) {
        return token.text + EOL
      }
      let language = 'plaintext'
      if (token.lang) {
        if (highlight.supportsLanguage(token.lang)) {
          language = token.lang
        } else {
          logForDebugging(
            `Language not supported while highlighting code, falling back to plaintext: ${token.lang}`,
          )
        }
      }
      return highlight.highlight(token.text, { language }) + EOL
    }
    case 'codespan': {
      // inline code
      return color('permission', theme)(token.text)
    }
    case 'em':
      return chalk.italic(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'strong':
      return chalk.bold(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'heading':
      switch (token.depth) {
        case 1: // h1
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        case 2: // h2
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        default: // h3+
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
      }
    case 'math': {
      const math = token as Tokens.Generic & {
        text: string
        displayMode?: boolean
      }
      if (!math.displayMode) {
        // inline math — codespan treatment, delimiters dropped
        return color('permission', theme)(math.text)
      }
      // display math — full 2D ANSI typesetting when the block is closed
      // and fits; the dim rail (mermaid-style) is the fallback for parse
      // errors and width overflow. While streaming an unclosed block grows
      // as plain dim source instead of showing the hint.
      if (!isClosedMathBlock(math)) {
        return chalk.dim(math.raw.trimEnd()) + EOL
      }
      const grid = renderMathGrid(math.text, theme, {
        // Same source as every other non-React width consumer in the repo;
        // undefined when stdout is not a tty (tests, pipes) means “no
        // limit”, which the layouter treats as unbounded.
        maxWidth: process.stdout.columns
          ? process.stdout.columns - 2
          : undefined,
      })
      if (grid) return grid + EOL
      return formatMathBlock(math.text)
    }
    case 'hr':
      return '---'
    case 'image':
      return token.href
    case 'link': {
      // Prevent mailto links from being displayed as clickable links
      if (token.href.startsWith('mailto:')) {
        // Extract email from mailto: link and display as plain text
        const email = token.href.replace(/^mailto:/, '')
        return email
      }
      // Extract display text from the link's child tokens
      const linkText = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, token, highlight))
        .join('')
      const plainLinkText = stripAnsi(linkText)
      // If the link has meaningful display text (different from the URL),
      // show it as a clickable hyperlink. In terminals that support OSC 8,
      // users see the text and can hover/click to see the URL.
      if (plainLinkText && plainLinkText !== token.href) {
        return createHyperlink(token.href, linkText)
      }
      // When the display text matches the URL (or is empty), just show the URL
      return createHyperlink(token.href)
    }
    case 'list': {
      return token.items
        .map((_: Token, index: number) =>
          formatToken(
            _,
            theme,
            listDepth,
            token.ordered ? token.start + index : null,
            token,
            highlight,
          ),
        )
        .join('')
    }
    case 'list_item': {
      // marked 17 wraps every item's content in a `paragraph` token (the
      // old `text`-child shape no longer occurs), so the bullet is emitted
      // here, on the first content block — otherwise every list renders
      // as plain run-on lines with no marker.
      const bullet =
        orderedListNumber === null
          ? '-'
          : `${getListNumber(listDepth, orderedListNumber)}.`
      return (token.tokens ?? [])
        .map((_, index) => {
          const indent =
            index === 0
              ? `${'  '.repeat(listDepth)}${bullet} `
              : '  '.repeat(listDepth)
          return `${indent}${formatToken(_, theme, listDepth + 1, orderedListNumber, token, highlight)}`
        })
        .join('')
    }
    case 'paragraph':
      return (
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, null, highlight))
          .join('') + EOL
      )
    case 'space':
      return EOL
    case 'br':
      return EOL
    case 'text':
      if (parent?.type === 'link') {
        // Already inside a markdown link — the link handler will wrap this
        // in an OSC 8 hyperlink. Linkifying here would nest a second OSC 8
        // sequence, and terminals honor the innermost one, overriding the
        // link's actual href.
        return token.text
      }
      if (parent?.type === 'list_item') {
        // The bullet comes from the list_item case itself (marked 17 never
        // produces this shape anymore; kept so a future shape change can
        // never double-prefix).
        return `${token.tokens ? token.tokens.map(_ => formatToken(_, theme, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}${EOL}`
      }
      return linkifyIssueReferences(token.text)
    case 'table': {
      const tableToken = token as Tokens.Table

      // Helper function to get the text content that will be displayed (after stripAnsi)
      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(
          tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? '',
        )
      }

      // Determine column widths based on displayed content (without formatting)
      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens))
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens))
          maxWidth = Math.max(maxWidth, cellLength)
        }
        return Math.max(maxWidth, 3) // Minimum width of 3
      })

      // Format header row
      let tableOutput = '| '
      tableToken.header.forEach((header, index) => {
        const content =
          header.tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? ''
        const displayText = getDisplayText(header.tokens)
        const width = columnWidths[index]!
        const align = tableToken.align?.[index]
        tableOutput +=
          padAligned(content, stringWidth(displayText), width, align) + ' | '
      })
      tableOutput = tableOutput.trimEnd() + EOL

      // Add separator row
      tableOutput += '|'
      columnWidths.forEach(width => {
        // Always use dashes, don't show alignment colons in the output
        const separator = '-'.repeat(width + 2) // +2 for spaces on each side
        tableOutput += separator + '|'
      })
      tableOutput += EOL

      // Format data rows
      tableToken.rows.forEach(row => {
        tableOutput += '| '
        row.forEach((cell, index) => {
          const content =
            cell.tokens
              ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
              .join('') ?? ''
          const displayText = getDisplayText(cell.tokens)
          const width = columnWidths[index]!
          const align = tableToken.align?.[index]
          tableOutput +=
            padAligned(content, stringWidth(displayText), width, align) + ' | '
        })
        tableOutput = tableOutput.trimEnd() + EOL
      })

      return tableOutput + EOL
    }
    case 'escape':
      // Markdown escape: \) → ), \\ → \, etc.
      return token.text
    case 'def':
    case 'del':
    case 'html':
      // These token types are not rendered
      return ''
  }
  return ''
}

const MERMAID_DIAGRAM_HINT = 'mermaid diagram (renders in the WebUI)'

/**
 * marked emits a single `code` token for an unclosed fence mid-stream (raw
 * runs to end of input), so "closed" is decided by raw's last line being a
 * closing fence marker rather than the token's mere presence.
 */
function isClosedCodeFence(token: Token): boolean {
  const lines = token.raw.trimEnd().split(EOL)
  return lines.length >= 2 && /^(`{3,}|~{3,})$/.test(lines[lines.length - 1]!)
}

/**
 * marked emits a single `math` token even for an unclosed `$$` opener
 * mid-stream (raw runs to end of input), so "closed" is decided by raw's
 * last line being the closing delimiter (or both delimiters sitting on the
 * single-line `$$x$$` / `\[x\]` form).
 */
export function isClosedMathBlock(token: Token): boolean {
  const raw = token.raw.trimEnd()
  const lines = raw.split(EOL)
  if (lines.length >= 2) {
    return /^\s*(?:\$\$|\\\])\s*$/.test(lines[lines.length - 1]!)
  }
  return raw.startsWith('$$')
    ? raw.length >= 5 && raw.endsWith('$$')
    : raw.startsWith('\\[') && raw.endsWith('\\]')
}

const LATEX_BLOCK_HINT = 'latex'

/**
 * Dim box treatment for a closed display-math block: hint line above the
 * raw LaTeX source, both behind a dim vertical bar (mermaid-style).
 */
function formatMathBlock(body: string): string {
  return formatDimRailDiagram(body, LATEX_BLOCK_HINT)
}

/**
 * Dim box treatment for a closed non-renderable block (mermaid, latex):
 * hint line above the raw body, both behind a dim vertical bar
 * (blockquote-style, no highlight).
 */
function formatDimRailDiagram(body: string, hint: string): string {
  const bar = chalk.dim('\u2502') // │
  const header = `${bar} ${chalk.dim.bold(hint)}`
  const lines = body
    .split(EOL)
    .map(line => (stripAnsi(line).trim() ? `${bar} ${chalk.dim(line)}` : line))
  return [header, ...lines].join(EOL) + EOL
}

function formatMermaidDiagram(body: string): string {
  return formatDimRailDiagram(body, MERMAID_DIAGRAM_HINT)
}

// Matches owner/repo#NNN style GitHub issue/PR references. The qualified form
// is unambiguous — bare #NNN was removed because it guessed the current repo
// and was wrong whenever the assistant discussed a different one.
// Owner segment disallows dots (GitHub usernames are alphanumerics + hyphens
// only) so hostnames like docs.github.io/guide#42 don't false-positive. Repo
// segment allows dots (e.g. cc.kurs.web). Lookbehind is avoided — it defeats
// YARR JIT in JSC.
const ISSUE_REF_PATTERN =
  /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * Replaces owner/repo#123 references with clickable hyperlinks to GitHub.
 */
function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REF_PATTERN,
    (_match, prefix, repo, num) =>
      prefix +
      createHyperlink(
        `https://github.com/${repo}/issues/${num}`,
        `${repo}#${num}`,
      ),
  )
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is the
 * visible width of `content` (caller computes this, e.g. via stringWidth on
 * stripAnsi'd text, so ANSI codes in `content` don't affect padding).
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}
