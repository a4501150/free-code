/**
 * Compaction has no measurable progress: the summary runs in an isolated forked
 * agent whose stream deltas never reach the parent, and token counts only land
 * once it finishes. So the bar is an elapsed-time estimate — it conveys "still
 * working, roughly this far in", not a real fraction of work done.
 *
 * Exponential rather than linear so it moves visibly early and decelerates,
 * and capped below 100 so it never claims to be finished. The bar is removed on
 * `compact_end` instead of completing.
 */
export function compactProgressPercent(elapsedMs: number): number {
  const seconds = Math.max(0, elapsedMs) / 1000
  return Math.min(95, Math.round((1 - Math.exp(-seconds / 90)) * 100))
}
