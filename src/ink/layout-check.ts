/**
 * Post-layout sanity checks (env-gated diagnostics).
 *
 * Yoga's flex layout guarantees that two non-absolute-positioned siblings
 * never overlap. A frame where they DO overlap means calculateLayout
 * served at least one subtree a stale cached result — the mixed-geometry
 * failure mode behind the monitor-detail leak (scroll container still
 * clipped at the modal-open viewport while the remounted bottom slot
 * painted at its pre-modal rows; both subtrees wrote the same rows).
 * This checker walks the finished layout and reports overlapping
 * non-absolute sibling pairs so the violation is visible in the debug log
 * instead of manifesting as a one-frame flash of transcript text over
 * the input row.
 *
 * Enable with FREECODE_LAYOUT_CHECK=1 (violations are logged by the
 * caller). Cheap enough to consider promoting to always-on later;
 * env-gated first to gauge the false-positive rate on real sessions.
 */
import type { DOMElement } from './dom.js'
import { LayoutDisplay } from './layout/node.js'

// Yoga layouts are fractional; a rounding pass expands each node's rect
// to floor(top)..ceil(bottom) so its span is fully covered on the cell
// grid. Adjacent fractionally-positioned siblings (flexShrink squeeze
// distributes e.g. 20/21-row children) legitimately share up to 2 cells
// this way — that's the cover expansion, not displacement. Only overlaps
// LARGER than cover rounding can explain are violations.
const COVER_ROUNDING_TOLERANCE = 2

export function isLayoutCheckEnabled(): boolean {
  // Read per call, no memoize: unit tests share one process and toggle
  // this between cases.
  return process.env.FREECODE_LAYOUT_CHECK === '1'
}

type Rect = { x: number; y: number; width: number; height: number }

// Component stack (populated when CLAUDE_CODE_DEBUG_REPAINTS is set) —
// without it every box is just "ink-box" and violations aren't actionable.
function describe(node: DOMElement): string {
  const chain = node.debugOwnerChain
  return chain && chain.length > 0
    ? `${node.nodeName}<${chain.slice(0, 3).join('/')}>`
    : node.nodeName
}

/**
 * Walk the DOM tree and verify that non-absolute siblings don't overlap.
 * Absolute-positioned children are exempt by design (modals, floating
 * overlays paint over siblings), but still walked — their descendants
 * hold non-absolute children of their own. Returns one violation string
 * per overlapping pair.
 */
export function checkLayoutInvariants(root: DOMElement): string[] {
  const violations: string[] = []
  const walk = (node: DOMElement, offsetX: number, offsetY: number) => {
    const { yogaNode } = node
    if (!yogaNode) return
    if (yogaNode.getDisplay() === LayoutDisplay.None) return

    const x = offsetX + yogaNode.getComputedLeft()
    const y = offsetY + yogaNode.getComputedTop()

    const rects: { rect: Rect; node: DOMElement }[] = []
    for (const childNode of node.childNodes) {
      const child = childNode as DOMElement
      const childYoga = child.yogaNode
      if (!childYoga) continue
      if (childYoga.getDisplay() === LayoutDisplay.None) continue
      const cx = x + childYoga.getComputedLeft()
      const cy = y + childYoga.getComputedTop()
      const rect: Rect = {
        x: cx,
        y: cy,
        width: childYoga.getComputedWidth(),
        height: childYoga.getComputedHeight(),
      }
      if (child.style.position !== 'absolute') {
        rects.push({ rect, node: child })
      }
      walk(child, x, y)
    }

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!
        const b = rects[j]!
        const overlapW =
          Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) -
          Math.max(a.rect.x, b.rect.x)
        const overlapH =
          Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) -
          Math.max(a.rect.y, b.rect.y)
        if (
          overlapW > COVER_ROUNDING_TOLERANCE &&
          overlapH > COVER_ROUNDING_TOLERANCE
        ) {
          violations.push(
            `${describe(node)}: non-absolute siblings overlap ` +
              `[${describe(a.node)} x=${a.rect.x.toFixed(1)} y=${a.rect.y.toFixed(1)} ` +
              `w=${a.rect.width.toFixed(1)} h=${a.rect.height.toFixed(1)}] vs ` +
              `[${describe(b.node)} x=${b.rect.x.toFixed(1)} y=${b.rect.y.toFixed(1)} ` +
              `w=${b.rect.width.toFixed(1)} h=${b.rect.height.toFixed(1)}] ` +
              `(overlap ${overlapW.toFixed(1)}x${overlapH.toFixed(1)})`,
          )
        }
      }
    }
  }
  walk(root, 0, 0)
  return violations
}
