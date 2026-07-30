import figures from 'figures'
import React, { Suspense, use, useEffect, useMemo } from 'react'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Ansi, Box, Text, useTheme } from '../../../ink.js'
import {
  type CliHighlight,
  getCliHighlightPromise,
} from '../../../utils/cliHighlight.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import sliceAnsi from '../../../utils/sliceAnsi.js'

type PreviewBoxProps = {
  /** The preview content to display. Markdown is rendered with syntax highlighting
   * for code blocks (```ts, ```py, etc.). Also supports plain multi-line text. */
  content: string
  /** Maximum number of lines the box body may occupy, including the scroll
   * indicator row when the content overflows. @default 20 */
  maxLines?: number
  /** First content line to display. Clamped internally to the scrollable range. */
  scrollOffset?: number
  /** Reports the largest usable scrollOffset so the owner can clamp its state. */
  onScrollBoundsChange?: (maxScrollOffset: number) => void
  /** Minimum height (in lines) for the preview box. Content will be padded if shorter. */
  minHeight?: number
  /** Minimum width for the preview box. @default 40 */
  minWidth?: number
  /** Maximum width available for this box (e.g., the container width). */
  maxWidth?: number
}

const BOX_CHARS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
}

/**
 * A bordered monospace box for displaying preview content.
 * Truncates content that exceeds maxLines with an indicator.
 * The parent component should pass maxLines based on its available height budget.
 */
export function PreviewBox(props: PreviewBoxProps): React.ReactNode {
  const settings = useSettings()
  if (settings.syntaxHighlightingDisabled) {
    return <PreviewBoxBody {...props} highlight={null} />
  }
  return (
    <Suspense fallback={<PreviewBoxBody {...props} highlight={null} />}>
      <PreviewBoxWithHighlight {...props} />
    </Suspense>
  )
}

function PreviewBoxWithHighlight(props: PreviewBoxProps): React.ReactNode {
  const highlight = use(getCliHighlightPromise())
  return <PreviewBoxBody {...props} highlight={highlight} />
}

function PreviewBoxBody({
  content,
  maxLines,
  minHeight,
  minWidth = 40,
  maxWidth,
  scrollOffset = 0,
  onScrollBoundsChange,
  highlight,
}: PreviewBoxProps & { highlight: CliHighlight | null }): React.ReactNode {
  const { columns: terminalWidth } = useTerminalSize()
  const [theme] = useTheme()
  const effectiveMaxWidth = maxWidth ?? terminalWidth - 4

  // Use provided maxLines, or a reasonable default
  const effectiveMaxLines = maxLines ?? 20

  // Render markdown with syntax highlighting for code blocks. applyMarkdown
  // returns an ANSI-styled string (bold, colors, etc.) that we split into
  // lines. stringWidth and sliceAnsi below correctly handle ANSI codes.
  const rendered = useMemo(
    () => applyMarkdown(content, theme, highlight),
    [content, theme, highlight],
  )
  const contentLines = rendered.split('\n')
  const isScrollable = contentLines.length > effectiveMaxLines

  // When the content overflows, the last body row becomes the scroll indicator
  // so the box height stays at effectiveMaxLines either way.
  const visibleCount = isScrollable
    ? Math.max(1, effectiveMaxLines - 1)
    : effectiveMaxLines
  const maxScrollOffset = Math.max(0, contentLines.length - visibleCount)
  const offset = Math.min(Math.max(0, scrollOffset), maxScrollOffset)
  const visibleLines = contentLines.slice(offset, offset + visibleCount)

  useEffect(() => {
    onScrollBoundsChange?.(maxScrollOffset)
  }, [maxScrollOffset, onScrollBoundsChange])

  // Pad content with empty lines if shorter than minHeight, but never exceed
  // the visible window — otherwise padding grows the box past its budget
  const effectiveMinHeight = Math.min(minHeight ?? 0, effectiveMaxLines)
  const paddingNeeded = Math.max(
    0,
    effectiveMinHeight - visibleLines.length - (isScrollable ? 1 : 0),
  )
  const lines =
    paddingNeeded > 0
      ? [...visibleLines, ...Array<string>(paddingNeeded).fill('')]
      : visibleLines

  // Calculate content width (max visual line width, handling unicode/emoji/CJK)
  const contentWidth = Math.max(
    minWidth,
    ...lines.map(line => stringWidth(line)),
  )
  // Add 2 for border padding, cap at the container width to prevent line wrapping
  const boxWidth = Math.min(contentWidth + 4, effectiveMaxWidth)
  const innerWidth = boxWidth - 4 // Account for borders and padding

  // Render top border
  const topBorder = `${BOX_CHARS.topLeft}${BOX_CHARS.horizontal.repeat(boxWidth - 2)}${BOX_CHARS.topRight}`

  // Render bottom border
  const bottomBorder = `${BOX_CHARS.bottomLeft}${BOX_CHARS.horizontal.repeat(boxWidth - 2)}${BOX_CHARS.bottomRight}`

  // Scroll position bar (e.g. ├─ ↑↓ 5-18 of 24 · shift+↑/↓ to scroll ─┤)
  const scrollBar = isScrollable
    ? (() => {
        const range = `${offset + 1}-${offset + visibleLines.length} of ${contentLines.length}`
        const fullLabel = ` ${figures.arrowUp}${figures.arrowDown} ${range} \u00b7 shift+${figures.arrowUp}/${figures.arrowDown} to scroll `
        const available = boxWidth - 2
        const label =
          stringWidth(fullLabel) <= available
            ? fullLabel
            : sliceAnsi(` ${range} `, 0, available)
        const fillWidth = Math.max(0, available - stringWidth(label))
        const leftFill = Math.min(3, fillWidth)
        return `${BOX_CHARS.teeLeft}${BOX_CHARS.horizontal.repeat(leftFill)}${label}${BOX_CHARS.horizontal.repeat(fillWidth - leftFill)}${BOX_CHARS.teeRight}`
      })()
    : null

  return (
    <Box flexDirection="column">
      <Text dimColor>{topBorder}</Text>

      {lines.map((line, index) => {
        // Pad or truncate line to fit inner width (using visual width for unicode/emoji/CJK).
        // sliceAnsi handles ANSI escape codes correctly; stringWidth strips them before measuring.
        const lineWidth = stringWidth(line)
        const displayLine =
          lineWidth > innerWidth ? sliceAnsi(line, 0, innerWidth) : line
        const padding = ' '.repeat(
          Math.max(0, innerWidth - stringWidth(displayLine)),
        )

        return (
          <Box key={index} flexDirection="row">
            <Text dimColor>{BOX_CHARS.vertical} </Text>
            <Ansi>{displayLine}</Ansi>
            <Text dimColor>
              {padding} {BOX_CHARS.vertical}
            </Text>
          </Box>
        )
      })}

      {scrollBar && <Text color="warning">{scrollBar}</Text>}

      <Text dimColor>{bottomBorder}</Text>
    </Box>
  )
}
