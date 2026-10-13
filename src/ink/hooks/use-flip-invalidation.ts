/**
 * Shared invalidations for a "flip" boundary — a render where a large
 * subtree swaps in or out (modal open/close, input-dialog focus change).
 *
 * A flip invalidates every cached layout rect (invalidateNodeCache): the
 * swapped subtree paints over rows in the shared screen buffer, so nodes
 * covered while it was mounted would blit its pixels as their own content
 * on the frame it unmounts. It also wipes yoga's internal layout cache
 * (Ink.invalidateLayoutCache): while e.g. a modal is open the bottom slot
 * renders null and its subtree goes cache-cold, so the flip can otherwise
 * leave the closing frame with a scroll container still clipped at the
 * modal-open (taller) viewport while the remounted input block renders at
 * its pre-modal rows — both subtrees paint, overlapping on the bottom rows
 * for one frame (the transient "transcript text on the input row" flash;
 * see Ink.invalidateLayoutCache).
 *
 * useLayoutEffect so the invalidations land synchronously before the
 * microtask-deferred onRender (scheduleRender queues a microtask from
 * resetAfterCommit; passive effects would land after it).
 */
import { useLayoutEffect, useRef } from 'react'
import instances from '../instances.js'
import { invalidateNodeCache } from '../node-cache.js'
import { markLayoutShifted } from '../render-node-to-output.js'

export function useFlipInvalidation(active: boolean): void {
  const hadActiveRef = useRef(active)
  useLayoutEffect(() => {
    if (hadActiveRef.current === active) return
    hadActiveRef.current = active
    invalidateNodeCache()
    instances.get(process.stdout)?.invalidateLayoutCache()
    markLayoutShifted()
  }, [active])
}
