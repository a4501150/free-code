import { StringDecoder } from 'node:string_decoder'
// Type-only: the module itself is loaded lazily in armPtyScreen — this file
// is imported by Shell.ts, which every process pulls in at boot, and the
// emulator must not cost non-interactive runs (MCP server, headless print)
// a startup parse.
import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless'

/**
 * The TUI's VT screen for the foreground interactive (`!`) PTY run.
 *
 * Raw PTY bytes are fed to a headless xterm emulator — the same engine the
 * WebUI's browser terminal runs — and the live viewport is re-serialized to
 * ANSI lines for <RawAnsi>, so full-screen apps (vim, htop) render and colors
 * pass straight through to the host terminal instead of being remapped.
 *
 * The emulator lives at module scope, not inside the component: deltas start
 * flowing before React commits the panel, and the screen survives panel
 * remounts (normal ↔ transcript view switches) without replaying bytes.
 */

export type PtyScreenSnapshot = {
  cols: number
  rows: number
  /** Exactly `rows` strings; each at most `cols` display columns, ANSI-styled. */
  lines: string[]
}

/** Left margin of the panel inside the transcript scroll area. */
export const PTY_PANEL_MARGIN = 2

export function ptyPanelColsFor(columns: number): number {
  return Math.max(20, columns - PTY_PANEL_MARGIN - 2)
}

export function ptyPanelRowsFor(rows: number): number {
  return Math.max(6, Math.min(16, Math.floor(rows / 2)))
}

const ESC = '\x1b'
const RESET = `${ESC}[0m`

/** SGR for one cell: attribute + fg + bg params, or null for default. */
function cellStyleParams(cell: IBufferCell, inverse: boolean): string | null {
  const parts: string[] = []
  if (cell.isBold()) parts.push('1')
  if (cell.isDim()) parts.push('2')
  if (cell.isItalic()) parts.push('3')
  if (cell.isUnderline()) parts.push('4')
  if (cell.isStrikethrough()) parts.push('9')
  if (inverse || cell.isInverse()) parts.push('7')
  if (cell.isFgRGB()) {
    const c = cell.getFgColor()
    parts.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`)
  } else if (cell.isFgPalette()) {
    parts.push(`38;5;${cell.getFgColor()}`)
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor()
    parts.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`)
  } else if (cell.isBgPalette()) {
    parts.push(`48;5;${cell.getBgColor()}`)
  }
  return parts.length > 0 ? parts.join(';') : null
}

/**
 * Serialize one grid row. Trailing default-styled spaces are trimmed (the
 * terminal pads implicitly); styled trailing spaces stay — they carry bg
 * color for full-width highlights.
 */
function serializeRow(
  line: IBufferLine,
  cols: number,
  cursorX: number,
): string {
  let out = ''
  let styled = false
  let current: string | null = null
  let trailingPlainSpaces = 0
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    // Wide-char continuation: the head cell already emitted the char.
    if (cell.getWidth() === 0) continue
    const style = cellStyleParams(cell, x === cursorX)
    if (style !== current) {
      if (styled) out += RESET
      if (style !== null) {
        out += `${ESC}[${style}m`
        styled = true
      } else {
        styled = false
      }
      current = style
    }
    const chars = cell.getChars()
    const char = chars || ' '
    if (style === null && char === ' ') {
      trailingPlainSpaces++
    } else {
      trailingPlainSpaces = 0
    }
    out += char
  }
  if (trailingPlainSpaces > 0) out = out.slice(0, -trailingPlainSpaces)
  if (styled) out += RESET
  return out
}

/** The bottom `rows` lines of the active buffer, cursor included. */
export function serializeViewport(term: Terminal): string[] {
  const buffer = term.buffer.active
  const cols = term.cols
  const rows = term.rows
  const top = Math.max(0, buffer.length - rows)
  // cursorY is relative to the viewport top; only draw it when the
  // viewport is the bottom region we render (headless keeps it there)
  // and the app did not hide the cursor (DECSET 25).
  const cursorRow =
    cursorVisible && buffer.viewportY === top ? buffer.cursorY : -1
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(top + y)
    lines.push(
      line
        ? serializeRow(line, cols, y === cursorRow ? buffer.cursorX : -1)
        : '',
    )
  }
  return lines
}

let term: Terminal | undefined
let TerminalCtor: (typeof import('@xterm/headless'))['Terminal'] | undefined
let decoder: StringDecoder | undefined
let cursorVisible = true
// The visibility DECSET (?25l/h) is not exposed on the headless buffer API —
// scan the byte stream for it. scanCarry holds a tail so a sequence split
// across deltas still matches; 40 bytes covers the longest combined DECSET
// (e.g. `?1049;2004;25h`) apps bundle.
let scanCarry = ''
let version = 0
let cached: { version: number; snapshot: PtyScreenSnapshot } | undefined
// Frame identity of the last committed snapshot — an identical repaint (idle
// prompt) skips the version bump and the subscriber notify.
let lastFrameKey: string | undefined
const subscribers = new Set<() => void>()
let notifyTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Coalesce paint notifications: a busy PTY fires a delta per read chunk, and
 * each one triggering a React render + re-serialization would burn CPU for
 * identical frames. One repaint per interval is well below perception.
 */
const NOTIFY_COALESCE_MS = 32

function commitSnapshot(lines: string[]): void {
  if (!term) return
  version++
  // Eagerly, not lazily on the next read: a run can end (disarm, PTY
  // dispose) before any reader returns, and the lazy path would freeze the
  // previous snapshot — dropping the run's final frame.
  cached = {
    version,
    snapshot: { cols: term.cols, rows: term.rows, lines },
  }
  for (const cb of subscribers) cb()
}

function scheduleNotify(): void {
  if (notifyTimer !== undefined) return
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined
    if (!term) return
    const lines = serializeViewport(term)
    const key = `${term.cols}x${term.rows}\n${lines.join('\n')}`
    if (key === lastFrameKey) return
    lastFrameKey = key
    commitSnapshot(lines)
  }, NOTIFY_COALESCE_MS)
  notifyTimer.unref?.()
}

function scanCursorVisibility(text: string): void {
  const scan = scanCarry + text
  const re = /\x1b\[\?(?:\d+;)*25(?:;\d+)*([hl])/g
  let match: RegExpExecArray | null
  while ((match = re.exec(scan))) {
    cursorVisible = match[1] === 'h'
  }
  scanCarry = scan.slice(-40)
}

/**
 * Start a new screen for the next interactive run. Must be awaited before
 * the PTY spawns (processBashCommand does, ahead of BashTool.call) — the
 * lazy emulator load resolves here, once per process.
 */
export async function armPtyScreen(cols: number, rows: number): Promise<void> {
  if (TerminalCtor === undefined) {
    TerminalCtor = (await import('@xterm/headless')).Terminal
  }
  term?.dispose()
  // scrollback 0: the panel renders only the live viewport, so a cols
  // shrink drops the reflowed remainder (unit-tested) rather than holding
  // it — buffer memory stays bounded at rows×cols cells.
  term = new TerminalCtor({ allowProposedApi: true, cols, rows, scrollback: 0 })
  decoder = new StringDecoder('utf8')
  cursorVisible = true
  scanCarry = ''
  // Drop the previous run's frozen frame NOW, not at the next paint tick:
  // the new panel's first render reads the snapshot before any byte or
  // tick arrives and would otherwise flash the previous command's screen.
  cached = undefined
  lastFrameKey = undefined
  scheduleNotify()
}

/**
 * Feed one raw PTY byte chunk of the current foreground interactive run.
 * Ignored unless armed. The caller gates on isForegroundPtyTask: a
 * Ctrl+B-backgrounded run keeps emitting after disarm, and those bytes
 * must never leak into the next armed panel.
 */
export function appendPtyScreenDelta(bytes: Buffer | string): void {
  if (!term || !decoder) return
  // The read loop's chunks can split a multi-byte character; a plain
  // toString would emit U+FFFD here. The decoder holds the partial tail
  // until the next chunk completes it.
  const text = decoder.write(bytes)
  scanCursorVisibility(text)
  // Notify from the write callback, not immediately: write() parses
  // asynchronously, so scheduling only after the chunk completed parsing
  // guarantees the committed snapshot includes these bytes.
  term.write(text, scheduleNotify)
}

/** Panel-driven resize (terminal width change). No-op when unarmed. */
export function resizePtyScreen(cols: number, rows: number): void {
  if (!term) return
  if (term.cols === cols && term.rows === rows) return
  term.resize(cols, rows)
  scheduleNotify()
}

/**
 * End the run. The emulator is disposed; the last cached snapshot survives
 * so a panel still mounted for a frame keeps a stable snapshot identity
 * until the next arm replaces it.
 */
export function disarmPtyScreen(): void {
  if (!term) return
  term.dispose()
  term = undefined
  decoder = undefined
  scanCarry = ''
}

export function subscribePtyScreen(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

const EMPTY_SNAPSHOT: PtyScreenSnapshot = {
  cols: 80,
  rows: 16,
  lines: [],
}

export function getPtyScreenSnapshot(): PtyScreenSnapshot {
  if (term && (!cached || cached.version !== version)) {
    cached = {
      version,
      snapshot: {
        cols: term.cols,
        rows: term.rows,
        lines: serializeViewport(term),
      },
    }
  }
  return cached?.snapshot ?? EMPTY_SNAPSHOT
}

/** Exposed for tests: the DEC-scan state resets per run. */
export function isPtyScreenCursorVisible(): boolean {
  return cursorVisible
}
