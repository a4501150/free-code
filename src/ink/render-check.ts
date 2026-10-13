/**
 * Differential render check (env-gated diagnostics).
 *
 * After the incremental frame is built, re-render the whole tree into a
 * fresh screen with every render cache bypassed (no prevScreen blits, no
 * scroll fast paths, no clean-skip) and compare cell-by-cell with the
 * frame's screen. When the incremental paths are healthy the two buffers
 * are identical; any divergence is a render-cache bug — a stale nodeCache
 * blit, a missed dirty flag, a scroll-repair gap — reported here instead
 * of living on the user's terminal as leaked or ghosted rows.
 *
 * Cannot catch stale YOGA layout (the reference re-renders from the same
 * layout pass — a mixed-geometry frame reproduces in both buffers); that
 * class belongs to checkLayoutInvariants in layout-check.ts.
 *
 * Enable with FREECODE_RENDER_CHECK=1 (mismatches are logged by the
 * caller). Costs a second full paint per frame, so keep it out of
 * steady-state usage.
 */
import Output from './output.js'
import renderNodeToOutput, {
  resetLayoutShifted,
  resetScrollDrainNode,
  resetScrollHint,
  setReferenceRender,
} from './render-node-to-output.js'
import {
  cellAtIndex,
  createScreen,
  type Screen,
  type StylePool,
} from './screen.js'
import type { DOMElement } from './dom.js'

export function isRenderCheckEnabled(): boolean {
  // Read per call, no memoize: unit tests share one process and toggle
  // this between cases.
  return process.env.FREECODE_RENDER_CHECK === '1'
}

export type RenderMismatch = {
  row: number
  col: number
  frameChar: string
  referenceChar: string
}

/**
 * Render the tree cache-free into a fresh screen and diff against the
 * frame's screen. Returns up to `limit` mismatching cells (there can be
 * many more). Module render state (shift flag, scroll hint, drain node)
 * is reset around the reference render so it doesn't observe or disturb
 * the real frame's bookkeeping — the shift flag is restored by the CALLER
 * via markLayoutShifted() since this module can't read it without another
 * import cycle.
 */
export function diffFrameAgainstReference(
  rootNode: DOMElement,
  frameScreen: Screen,
  stylePool: StylePool,
  limit = 8,
): RenderMismatch[] {
  const reference = createScreen(
    frameScreen.width,
    frameScreen.height,
    stylePool,
    frameScreen.charPool,
    frameScreen.hyperlinkPool,
  )
  const output = new Output({
    width: frameScreen.width,
    height: frameScreen.height,
    stylePool,
    screen: reference,
  })
  resetLayoutShifted()
  resetScrollHint()
  resetScrollDrainNode()
  setReferenceRender(true)
  try {
    renderNodeToOutput(rootNode, output, { prevScreen: undefined })
  } finally {
    setReferenceRender(false)
  }
  const rendered = output.get()

  const mismatches: RenderMismatch[] = []
  const a = frameScreen.cells64
  const b = rendered.cells64
  const n = Math.min(a.length, b.length)
  let firstRow = -1
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue
    const row = Math.floor(i / frameScreen.width)
    const col = i % frameScreen.width
    const frameCell = cellAtIndex(frameScreen, i)
    const refCell = cellAtIndex(rendered, i)
    mismatches.push({
      row,
      col,
      frameChar: frameCell.char ?? '?',
      referenceChar: refCell.char ?? '?',
    })
    if (firstRow < 0) firstRow = row
    if (mismatches.length >= limit) break
  }
  // Row context for the first mismatched row — the deciding evidence
  // between a real hole (frame row blank/corrupt) and a one-row shift
  // or mid-drain transient (frame content offset from reference).
  if (firstRow >= 0) {
    const rowText = (screen: Screen) => {
      let out = ''
      const base = firstRow * screen.width
      for (let c = 0; c < Math.min(60, screen.width); c++) {
        const cell = cellAtIndex(screen, base + c)
        out += cell.char === ' ' || !cell.char ? '·' : cell.char
      }
      return out
    }
    const first = mismatches[0]!
    ;(
      first as RenderMismatch & { frameRow?: string; referenceRow?: string }
    ).frameRow = rowText(frameScreen)
    ;(
      first as RenderMismatch & { frameRow?: string; referenceRow?: string }
    ).referenceRow = rowText(rendered)
  }
  return mismatches
}
