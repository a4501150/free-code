// TEMPORARY DIAGNOSTIC — remove once the duplicate-row bug is root-caused.
// Surfaces through the normal debug log, so `--debug` is the only switch.
import { logForDebugging } from './debug.js'

let lastSignature = ''

export function diagRenderedList(
  items: { uuid: string; type: string }[],
  syntheticCount: number,
): void {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item.uuid, (counts.get(item.uuid) ?? 0) + 1)
  }
  const dups = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  // Throttle: this sits in a render path, so only report when the shape moves.
  const signature = `${items.length}|${syntheticCount}|${dups.map(d => d.join(':')).join(',')}`
  if (signature === lastSignature) return
  lastSignature = signature
  logForDebugging(
    `[DupRows] listLength=${items.length} synthetic=${syntheticCount} distinctUuids=${counts.size} duplicates=${
      dups.length === 0
        ? 'none'
        : dups.map(([uuid, n]) => `${uuid}x${n}`).join(',')
    }`,
  )
}
