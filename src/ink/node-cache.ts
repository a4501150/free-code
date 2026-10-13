import type { DOMElement } from './dom.js'
import type { Rectangle } from './layout/geometry.js'

/**
 * Cached layout bounds for each rendered node (used for blit + clearing).
 * `top` is the yoga-local getComputedTop() — stored so ScrollBox viewport
 * culling can skip yoga reads for clean children whose position hasn't
 * shifted (O(dirty) instead of O(mounted) first-pass).
 */
export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  top?: number
}

export let nodeCache = new WeakMap<DOMElement, CachedLayout>()

/**
 * Drop every cached layout rect so the next frame full-renders (clean-skip
 * blits require a cache entry). Call when a bottom-anchored absolute modal
 * mounts or unmounts: while it is open it paints its own pixels over the
 * transcript rows in the shared screen buffer, so clean nodes under it
 * blit the modal's pixels as if they were their own; the stale caches then
 * surface as ghosts when the modal closes. The per-node pendingClear path
 * covers single removals but not the mount direction nor the covered-while-
 * open staleness. Replacing the WeakMap (rather than iterating) works with
 * importers because ES live bindings re-read the export on each access.
 */
export function invalidateNodeCache(): void {
  nodeCache = new WeakMap<DOMElement, CachedLayout>()
}

/** Rects of removed children that need clearing on next render */
export const pendingClears = new WeakMap<DOMElement, Rectangle[]>()

/**
 * Set when a pendingClear is added for an absolute-positioned node.
 * Signals renderer to disable blit for the next frame: the removed node
 * may have painted over non-siblings (e.g. an overlay over a ScrollBox
 * earlier in tree order), so their blits from prevScreen would restore
 * the overlay's pixels. Normal-flow removals are already handled by
 * hasRemovedChild at the parent level; only absolute positioning paints
 * cross-subtree. Reset at the start of each render.
 */
let absoluteNodeRemoved = false

export function addPendingClear(
  parent: DOMElement,
  rect: Rectangle,
  isAbsolute: boolean,
): void {
  const existing = pendingClears.get(parent)
  if (existing) {
    existing.push(rect)
  } else {
    pendingClears.set(parent, [rect])
  }
  if (isAbsolute) {
    absoluteNodeRemoved = true
  }
}

export function consumeAbsoluteRemovedFlag(): boolean {
  const had = absoluteNodeRemoved
  absoluteNodeRemoved = false
  return had
}
