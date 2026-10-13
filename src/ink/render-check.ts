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
  beginReferenceRender,
  endReferenceRender,
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
 * many more). Module render state is snapshotted around the reference
 * render (beginReferenceRender/endReferenceRender) so the walk neither
 * observes nor disturbs the real frame's bookkeeping — the real frame's
 * shift-flag verdicts are restored exactly, for the full-damage decision
 * and DECSTBM gate that run after this.
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
  const shiftFlags = beginReferenceRender()
  try {
    renderNodeToOutput(rootNode, output, { prevScreen: undefined })
  } finally {
    endReferenceRender(shiftFlags)
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
  // or mid-drain transient (frame content offset from reference). Also
  // dumps the two rows on each side: a whole-block shift shows the same
  // content one row off; a lone hole is bounded by intact rows.
  if (firstRow >= 0) {
    const rowText = (screen: Screen, row: number) => {
      if (row < 0 || row >= screen.height) return '(off-screen)'
      let out = ''
      const base = row * screen.width
      for (let c = 0; c < Math.min(60, screen.width); c++) {
        const cell = cellAtIndex(screen, base + c)
        out += cell.char === ' ' || !cell.char ? '·' : cell.char
      }
      return out
    }
    const first = mismatches[0]!
    const withRows = first as RenderMismatch & {
      frameRow?: string
      referenceRow?: string
      context?: string
      fullFrame?: string
      fullReference?: string
    }
    withRows.frameRow = rowText(frameScreen, firstRow)
    withRows.referenceRow = rowText(rendered, firstRow)
    // Complete both screens on the first mismatching frame — the
    // per-frame contexts above cannot show a whole-screen shift vs a
    // local hole.
    const fullScreen = (screen: Screen): string => {
      const rows: string[] = []
      for (let r = 0; r < screen.height; r++) {
        let out = ''
        const base = r * screen.width
        for (let c = 0; c < Math.min(70, screen.width); c++) {
          const cell = cellAtIndex(screen, base + c)
          out += cell.char === ' ' || !cell.char ? '·' : cell.char
        }
        rows.push(out)
      }
      return rows.join('\n')
    }
    withRows.fullFrame = fullScreen(frameScreen)
    withRows.fullReference = fullScreen(rendered)
    // All diverging rows (bounded): each with both buffers' text, so a
    // shift vs a hole vs a stale-region overlap is readable at a glance.
    const divergingRows = [...new Set(mismatches.map(m => m.row))]
    withRows.context = divergingRows
      .slice(0, 12)
      .map(
        r => `row ${r}: F=${rowText(frameScreen, r)} R=${rowText(rendered, r)}`,
      )
      .join('\n  ')
    // Mismatch row spread: how many DISTINCT rows diverge (bounds the
    // damage without logging every cell).
    ;(first as RenderMismatch & { mismatchRows?: number }).mismatchRows =
      divergingRows.length
  }
  return mismatches
}
