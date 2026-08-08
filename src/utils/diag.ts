// TEMPORARY DIAGNOSTIC — remove once the duplicate-row bug is root-caused.
// Writes JSON lines to the path in FREECODE_DIAG. No-op when unset.
import { appendFileSync } from 'fs'

const DIAG_PATH = process.env.FREECODE_DIAG ?? null

let lastSignature = ''

export function diagRenderedList(
  items: { uuid: string; type: string; message?: unknown }[],
  syntheticCount: number,
): void {
  if (!DIAG_PATH) return
  try {
    const counts = new Map<string, number>()
    for (const item of items) {
      counts.set(item.uuid, (counts.get(item.uuid) ?? 0) + 1)
    }
    const dups = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    const signature = `${items.length}|${syntheticCount}|${dups.map(d => d.join(':')).join(',')}`
    if (signature === lastSignature) return
    lastSignature = signature
    appendFileSync(
      DIAG_PATH,
      `${JSON.stringify({
        t: new Date().toISOString(),
        listLength: items.length,
        syntheticCount,
        distinctUuids: counts.size,
        duplicateUuids: dups.map(([uuid, n]) => ({ uuid, n })),
      })}\n`,
    )
  } catch {
    // diagnostics must never break rendering
  }
}
