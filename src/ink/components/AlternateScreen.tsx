import React, {
  type PropsWithChildren,
  useContext,
  useInsertionEffect,
} from 'react'
import instances from '../instances.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from '../termio/dec.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import Box from './Box.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'

type Props = PropsWithChildren<{
  /** Enable SGR mouse tracking (wheel + click/drag). Default true. */
  mouseTracking?: boolean
}>

/**
 * Run children in the terminal's alternate screen buffer, constrained to
 * the viewport height. Alt-screen is the app's ONLY TUI render mode, so
 * every interactive tree mounts inside this provider. While mounted:
 *
 * - Enters the alt screen (DEC 1049), clears it, homes the cursor
 * - Constrains its own height to the terminal row count, so overflow must
 *   be handled via `overflow: scroll` / flexbox (no native scrollback)
 * - Optionally enables SGR mouse tracking (wheel + click/drag) — events
 *   surface as `ParsedKey` (wheel) and update the Ink instance's
 *   selection state (click/drag)
 *
 * On unmount, disables mouse tracking and exits the alt screen, restoring
 * the main screen's content — that's the terminal-side half of a handoff
 * (sequential setup dialogs, process exit), not a mode switch: the engine
 * stays in alt-screen mode (notifyAltScreenActive is one-way).
 *
 * Notifies the Ink instance via `notifyAltScreenActive()` so the renderer
 * keeps the cursor inside the viewport (preventing the cursor-restore LF
 * from scrolling content) and so signal-exit cleanup can exit the alt
 * screen if the component's own unmount doesn't run.
 */
export function AlternateScreen({
  children,
  mouseTracking = true,
}: Props): React.ReactNode {
  const size = useContext(TerminalSizeContext)
  const writeRaw = useContext(TerminalWriteContext)

  // useInsertionEffect (not useLayoutEffect): react-reconciler calls
  // resetAfterCommit between the mutation and layout commit phases, and
  // Ink's resetAfterCommit triggers onRender. With useLayoutEffect, that
  // first onRender fires BEFORE this effect — writing a full frame to the
  // main screen with altScreen=false. That frame is preserved when we
  // enter alt screen and revealed on exit as a broken view. Insertion
  // effects fire during the mutation phase, before resetAfterCommit, so
  // ENTER_ALT_SCREEN reaches the terminal before the first frame does.
  // Cleanup timing is unchanged: both insertion and layout effect cleanup
  // run in the mutation phase on unmount, before resetAfterCommit.
  useInsertionEffect(() => {
    const ink = instances.get(process.stdout)
    if (!writeRaw) return

    writeRaw(
      ENTER_ALT_SCREEN +
        '\x1b[2J\x1b[H' +
        (mouseTracking ? ENABLE_MOUSE_TRACKING : ''),
    )
    ink?.notifyAltScreenActive(mouseTracking)

    return () => {
      // Terminal-side restore only: the engine's alt-screen mode is
      // one-way (there is no "main-screen mode" to fall back into), so no
      // ink-side call here — a tree that mounts after this one re-enters
      // alt through its own notifyAltScreenActive.
      ink?.clearTextSelection()
      writeRaw((mouseTracking ? DISABLE_MOUSE_TRACKING : '') + EXIT_ALT_SCREEN)
    }
  }, [writeRaw, mouseTracking])

  return (
    <Box
      flexDirection="column"
      height={size?.rows ?? 24}
      width="100%"
      flexShrink={0}
    >
      {children}
    </Box>
  )
}
