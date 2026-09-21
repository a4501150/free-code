/**
 * Unit tests for the shift fast path in LogUpdate.render: a uniform upward
 * row shift (fullscreen scroll-follow) must be emitted as one DECSTBM
 * region scroll + a small repaint, not a rewrite of every visible row.
 */

import { describe, expect, test } from 'bun:test'
import { LogUpdate } from '../../src/ink/log-update.js'
import type { Frame } from '../../src/ink/frame.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  type Hyperlink,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../../src/ink/screen.js'
import {
  CURSOR_HOME,
  RESET_SCROLL_REGION,
  scrollUp as csiScrollUp,
  setScrollRegion,
} from '../../src/ink/termio/csi.js'

type Pools = {
  styles: StylePool
  chars: CharPool
  links: HyperlinkPool
}

function pools(): Pools {
  return {
    styles: new StylePool(),
    chars: new CharPool(),
    links: new HyperlinkPool(),
  }
}

function textScreen(lines: string[], p: Pools, width = 12) {
  const screen = createScreen(width, lines.length, p.styles, p.chars, p.links)
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      setCellAt(screen, x, y, {
        char: line[x]!,
        styleId: p.styles.none,
        width: CellWidth.Narrow,
        hyperlink: undefined as Hyperlink,
      })
    }
  })
  return screen
}

function frame(
  screen: ReturnType<typeof textScreen>,
  viewportHeight: number,
  cursorY = 0,
): Frame {
  return {
    screen,
    viewport: { width: 12, height: viewportHeight },
    cursor: { x: 0, y: cursorY, visible: true },
    scrollHint: null,
  }
}

function serialize(diff: ReturnType<LogUpdate['render']>): string {
  return diff
    .map(patch => (patch.type === 'stdout' ? patch.content : `<${patch.type}>`))
    .join('')
}

// Text actually written, ignoring cursor choreography and erase sequences
// (sub-12-cell rows are patched per cell, so characters interleave with
// cursor moves in the raw patch list).
function writtenText(diff: ReturnType<LogUpdate['render']>): string {
  return diff
    .filter(patch => patch.type === 'stdout')
    .map(patch =>
      (patch as { content: string }).content
        .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\u001B\][^\u0007]*\u0007/g, ''),
    )
    .join('')
}

const ROWS = [
  'row one',
  'row two',
  'row three',
  'row four',
  'row five',
  'row six',
]
const H = ROWS.length

describe('shift fast path', () => {
  test('uniform upward shift emits one DECSTBM scroll in alt-screen without sync support', () => {
    const p = pools()
    const prev = textScreen(ROWS, p)
    const next = textScreen([...ROWS.slice(1), 'new bottom'], p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    const diff = lu.render(frame(prev, H), frame(next, H), true, false)
    const out = serialize(diff)
    // Region excludes the entered row (the new content deviates from
    // itself, so the pinned-tail scan stops there).
    expect(out).toContain(setScrollRegion(1, H - 1))
    expect(out).toContain(csiScrollUp(1))
    expect(out).toContain(RESET_SCROLL_REGION)
    expect(out).toContain(CURSOR_HOME)
    // Only the entered row and the hardware-blanked region-bottom row are
    // repainted; the purely shifted rows are not rewritten cell-by-cell.
    // The entered row is below the region (it deviates from itself, so the
    // pinned-tail scan stops there) and is patched against its old
    // content — unchanged columns are skipped, hence the loose match.
    const written = writtenText(diff).replace(/\s+/g, '')
    expect(written).toContain('bottom')
    // The scroll blanked the region-bottom row, so its content is painted.
    expect(written).toContain('rowsix')
    for (const row of ROWS.slice(1, -1)) {
      expect(written).not.toContain(row.replace(/\s+/g, ''))
    }
  })

  test('local single-row edit is NOT emitted as a scroll', () => {
    const p = pools()
    const prev = textScreen(ROWS, p)
    const edited = [...ROWS]
    edited[2] = 'EDITED!!!!'
    const next = textScreen(edited, p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    const diff = lu.render(frame(prev, H), frame(next, H), true, false)
    const out = serialize(diff)
    expect(out).not.toContain(setScrollRegion(1, H))
    expect(writtenText(diff)).toContain('EDITED')
  })

  test('identical frame emits no scroll', () => {
    const p = pools()
    const prev = textScreen(ROWS, p)
    const next = textScreen(ROWS, p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    const diff = lu.render(frame(prev, H), frame(next, H), true, false)
    expect(serialize(diff)).not.toContain(setScrollRegion(1, H))
  })

  test('shift with deviating rows is still scrolled; deviating rows are repainted', () => {
    const p = pools()
    const prev = textScreen(ROWS, p)
    const nextLines = [...ROWS.slice(1), 'new bottom']
    nextLines[1] = 'DEVIATED!!!!' // does not match prev row 3
    const next = textScreen(nextLines, p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    const diff = lu.render(frame(prev, H), frame(next, H), true, false)
    const out = serialize(diff)
    expect(out).toContain(setScrollRegion(1, H - 1))
    const written = writtenText(diff).replace(/\s+/g, '')
    expect(written).toContain('DEVIATED')
    expect(written).toContain('bottom')
    // The coalesced row paints before erasing its tail: no blank-row
    // intermediate state on terminals that show partial writes.
    expect(out.indexOf('DEVIATED!!!!')).toBeLessThan(
      out.lastIndexOf('\u001B[K'),
    )
  })

  test('main-screen scroll only applies when content exactly fills the viewport', () => {
    const p = pools()
    const prev = textScreen(ROWS, p)
    const next = textScreen([...ROWS.slice(1), 'new bottom'], p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    // Viewport taller than content: rows below the content are not part of
    // the region scroll's row mapping on the main screen — plain diff only.
    const diff = lu.render(frame(prev, H + 2), frame(next, H + 2), false, false)
    expect(serialize(diff)).not.toContain(setScrollRegion(1, H))
  })

  test('main-screen exact-fill case scrolls', () => {
    const p = pools()
    const prev = textScreen(ROWS, p)
    const next = textScreen([...ROWS.slice(1), 'new bottom'], p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    const diff = lu.render(frame(prev, H), frame(next, H), false, false)
    expect(serialize(diff)).toContain(setScrollRegion(1, H - 1))
  })

  test('shift below a bottom-pinned block scrolls only the region above it', () => {
    const p = pools()
    // Bottom two rows are the pinned block (spinner/input): they stay at
    // the same y in both frames while the transcript above scrolls up by
    // one. The scroll region must stop above the pinned rows, and the
    // pinned rows must not be rewritten.
    const prevLines = [...ROWS, 'pin A', 'pin B']
    const nextLines = [...ROWS.slice(1), 'new bottom', 'pin A', 'pin B']
    const prev = textScreen(prevLines, p)
    const next = textScreen(nextLines, p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    const diff = lu.render(frame(prev, H + 2), frame(next, H + 2), true, false)
    const out = serialize(diff)
    // Region ends at row 5 (the entered row deviates from itself and
    // joins the painted tail), well above the screen bottom.
    expect(out).toContain(setScrollRegion(1, H - 1))
    expect(out).not.toContain(setScrollRegion(1, H))
    expect(out).not.toContain(setScrollRegion(1, H + 2))
    expect(out).toContain(csiScrollUp(1))
    const written = writtenText(diff).replace(/\s+/g, '')
    expect(written).toContain('bottom')
    expect(written).not.toContain('pinA')
    expect(written).not.toContain('pinB')
  })

  test('an animating pinned spinner row is patched, not rewritten, while the transcript scrolls', () => {
    const p = pools()
    // The frame a scroll-follow commit produces with a live spinner:
    // transcript rows shift up by one, a new tool row enters at the
    // region bottom, the spinner verb row ticks its glyph, and the
    // footer gains a hint. Only the entered row is new content; the
    // spinner and footer deviate from themselves by only a few cells,
    // so they belong to the pinned tail and must be patched per cell —
    // never an erase-and-rewrite of the row (the visible title blink).
    const prevLines = [
      'row one',
      'row two',
      'row three',
      'row four',
      '✻ Thinking…',
      'hint',
    ]
    const nextLines = [
      'row two',
      'row three',
      'row four',
      'ENTERED!!!',
      '✢ Thinking…',
      'hint more',
    ]
    const prev = textScreen(prevLines, p)
    const next = textScreen(nextLines, p)
    const lu = new LogUpdate({ isTTY: true, stylePool: p.styles })
    const diff = lu.render(frame(prev, H), frame(next, H), true, false)
    const out = serialize(diff)
    // Region stops at the entered row (y=3), below the spinner row.
    expect(out).toContain(setScrollRegion(1, 3))
    expect(out).toContain(csiScrollUp(1))
    const written = writtenText(diff).replace(/\s+/g, '')
    // The new tool row and the spinner glyph transition are painted…
    expect(written).toContain('ENTERED')
    expect(written).toContain('✢')
    // …but neither pinned row is rewritten wholesale: their unchanged
    // content appears nowhere in the emitted writes.
    expect(written).not.toContain('Thinking')
    expect(written).not.toContain('hint')
  })
})
