import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, useInput } from '../ink.js'
import { RawAnsi } from '../ink/components/RawAnsi.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidthNoEllipsis as truncateToWidth } from '../utils/truncate.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getSinglePtyHandle } from '../utils/shell/ptyShell.js'
import {
  getPtyScreenSnapshot,
  ptyPanelColsFor,
  ptyPanelRowsFor,
  PTY_PANEL_MARGIN,
  resizePtyScreen,
  subscribePtyScreen,
} from '../utils/shell/ptyScreen.js'
import type { ShellProgress } from '../types/tools.js'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

type Props = {
  input: string
  progress: ShellProgress | null
  verbose: boolean
}

/** `╭─ label ───╮` / `╰─ label ───╯` — border row with an embedded label. */
function labeledBorder(
  left: string,
  label: string,
  right: string,
  width: number,
): string {
  const innerWidth = width - 2
  const lab = truncateToWidth(label, Math.max(1, innerWidth - 3))
  const dashes = Math.max(1, innerWidth - 3 - stringWidth(lab))
  return `${DIM}${left}─ ${lab} ${'─'.repeat(dashes)}${right}${RESET}`
}

/**
 * Live terminal panel for an interactive (PTY) bash-mode `!` command — a
 * boxed slice of a real VT screen embedded in the transcript flow. Raw PTY
 * bytes are parsed by a headless xterm emulator (see ptyScreen.ts) and the
 * viewport is re-serialized through <RawAnsi>, so full-screen apps and
 * colors render as they would in a standalone terminal.
 *
 * Keypresses are forwarded to the child verbatim as raw escape sequences —
 * the PTY's line discipline does echo, canonical editing and password
 * suppression. Escape (chat:cancel) and Ctrl+B (task:background) keep their
 * app-level meanings and are never forwarded: Esc tree-kills the run, Ctrl+B
 * turns it into a background task exactly like a non-interactive command.
 */
export function InteractiveBashProgress({ input }: Props): React.ReactNode {
  // The panel participates in the DOM focus system (tabIndex + autoFocus):
  // while the run is live it is the activeElement, so tree-dispatched
  // keydowns land here and never reach the prompt container — which stays
  // mounted and visible below the box, together with the rows after it.
  // Keypress forwarding rides the legacy useInput channel because
  // KeyboardEvent normalizes away the raw escape sequence the child's
  // line discipline expects; the channel only fires for keys the tree did
  // not consume and is gated on panel focus, so a dialog that steals
  // focus can no longer type into the child.
  const [focused, setFocused] = useState(true)

  useInput((textInput, key, event) => {
    if (key.escape) return
    if (key.ctrl && textInput === 'b') return
    if (!focused) return
    const sequence = event.keypress.sequence
    if (sequence) getSinglePtyHandle()?.write(sequence)
  })

  const { columns, rows } = useTerminalSize()
  const snapshot = useSyncExternalStore(
    subscribePtyScreen,
    getPtyScreenSnapshot,
  )
  const cols = ptyPanelColsFor(columns)
  const panelRows = ptyPanelRowsFor(rows)

  // Terminal resize → emulator + child resize. No-op while the panel size
  // already matches (the effect also corrects an arm computed from a stale
  // process.stdout size).
  useEffect(() => {
    if (snapshot.cols === cols && snapshot.rows === panelRows) return
    resizePtyScreen(cols, panelRows)
    getSinglePtyHandle()?.resize(cols, panelRows)
  }, [cols, panelRows, snapshot.cols, snapshot.rows])

  const lines = useMemo(() => {
    const panelWidth = cols + 2
    const grid =
      snapshot.lines.length > 0
        ? snapshot.lines
        : Array.from({ length: panelRows }, () => '')
    return [
      labeledBorder('╭', `! ${input}`, '╮', panelWidth),
      ...grid.map(line => {
        // Rows are serialized trimmed; pad to full width so the right
        // border stays aligned.
        const pad = Math.max(0, cols - stringWidth(line))
        return `${DIM}│${RESET}${line}${' '.repeat(pad)}${DIM}│${RESET}`
      }),
      labeledBorder(
        '╰',
        focused
          ? 'interactive · Esc kill · Ctrl+B background'
          : 'unfocused · click to interact · Esc kill · Ctrl+B background',
        '╯',
        panelWidth,
      ),
    ]
  }, [snapshot, input, cols, panelRows, focused])

  return (
    <Box
      flexDirection="column"
      marginLeft={PTY_PANEL_MARGIN}
      marginTop={1}
      tabIndex={0}
      autoFocus
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <RawAnsi lines={lines} width={cols + 2} />
    </Box>
  )
}
