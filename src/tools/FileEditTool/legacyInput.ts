// Converts legacy old_string/new_string Edit inputs into anchored edits before
// schema validation. Models trained on the classic Claude Code Edit shape keep
// emitting content-replacement fields despite the anchor schema; the intent is
// unambiguous and the file is right here, so resolving the match locally beats
// a reject-and-retry round trip.

import { readFileSync } from 'node:fs'
import { ToolInputCoercionError } from '../../utils/toolErrors.js'
import { computeHashlineLabels } from '../../utils/hashline.js'

type LegacyOp = {
  oldText: string
  newText: string
  replaceAll: boolean
}

// Returns canonical-shaped input ({file_path, edits}) when legacy fields are
// present and resolvable; passes everything else through untouched. Throws
// ToolInputCoercionError when a legacy match is absent or ambiguous — errors
// that teach the anchor format instead of a generic validation miss.
export function coerceLegacyEditInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.file_path !== 'string') return raw

  // When an edits array is present, top-level old_string/new_string are
  // synthetic leftovers from pre-anchor sessions, not a replacement request.
  const entries: unknown[] = Array.isArray(obj.edits) ? obj.edits : []
  const topLegacy = entries.length === 0 ? parseLegacyOp(obj) : undefined
  const legacyEntries = entries.filter(
    (e): e is Record<string, unknown> =>
      typeof e === 'object' &&
      e !== null &&
      isLegacyEntry(e as Record<string, unknown>),
  )
  if (legacyEntries.length === 0 && topLegacy === undefined) return raw

  let content: string
  try {
    content = readFileSync(obj.file_path, 'utf8')
  } catch {
    return raw
  }
  const lineOffsets = computeLineOffsets(content)
  const labels = computeHashlineLabels(content).labels
  const anchor = (line: number): string =>
    `${line}:${labels[line - 1]?.hash ?? ''}`

  const convertedByEntry = new Map<
    Record<string, unknown>,
    Array<Record<string, unknown>>
  >()
  for (const entry of legacyEntries) {
    const op = parseLegacyOp(entry)
    if (op) {
      convertedByEntry.set(
        entry,
        opToEdits(op, content, lineOffsets, anchor, obj.file_path),
      )
    }
  }
  const topEdits = topLegacy
    ? opToEdits(topLegacy, content, lineOffsets, anchor, obj.file_path)
    : []

  const out: Array<Record<string, unknown>> = [...topEdits]
  for (const entry of entries) {
    const converted = convertedByEntry.get(entry as Record<string, unknown>)
    if (converted) out.push(...converted)
    else out.push(entry as Record<string, unknown>)
  }

  assertNoOverlap(out, obj.file_path)
  return { file_path: obj.file_path, edits: out }
}

function isLegacyEntry(v: Record<string, unknown>): boolean {
  if ('start' in v) return false
  return legacyTextKeys(v) !== undefined
}

function legacyTextKeys(
  e: Record<string, unknown>,
): { old: string; new: string } | undefined {
  const old = e.old_string ?? e.oldText
  const newText = e.new_string ?? e.newText
  if (typeof old === 'string' && typeof newText === 'string') {
    return { old, new: newText }
  }
  return undefined
}

function parseLegacyOp(e: Record<string, unknown>): LegacyOp | undefined {
  const keys = legacyTextKeys(e)
  if (!keys) return undefined
  if (keys.old === '') {
    throw new ToolInputCoercionError(
      `"old_string" is empty; a content replacement must match real file text. Use edits[] with LINE:HASH anchors from Read output.`,
    )
  }
  return {
    oldText: keys.old,
    newText: keys.new,
    replaceAll: e.replace_all === true || e.replaceAll === true,
  }
}

// One legacy op -> anchored replace edits over the original content.
function opToEdits(
  op: LegacyOp,
  content: string,
  lineOffsets: number[],
  anchor: (line: number) => string,
  filePath: string,
): Array<Record<string, unknown>> {
  const matches: number[] = []
  let idx = content.indexOf(op.oldText)
  while (idx !== -1) {
    matches.push(idx)
    idx = content.indexOf(op.oldText, idx + op.oldText.length)
  }
  if (matches.length === 0) {
    throw new ToolInputCoercionError(
      `"old_string" was not found in ${filePath}. Read the file, then use edits[] with LINE:HASH anchors, or match the file text exactly.`,
    )
  }
  if (matches.length > 1 && !op.replaceAll) {
    const anchors = matches
      .map(m => anchor(lineForOffset(lineOffsets, m)))
      .join(', ')
    throw new ToolInputCoercionError(
      `"old_string" matches ${matches.length} places in ${filePath} (anchors ${anchors}). Add more surrounding text, set "replace_all": true, or use edits[] with these anchors.`,
    )
  }

  // Cluster matches whose line spans touch (two matches on one line share an
  // edit); replace_all across distant matches yields one edit per cluster.
  type Cluster = { startLine: number; endLine: number; offsets: number[] }
  const clusters: Cluster[] = []
  for (const m of matches) {
    const startLine = lineForOffset(lineOffsets, m)
    const endLine = lineForOffset(lineOffsets, m + op.oldText.length - 1)
    const last = clusters[clusters.length - 1]
    if (last && startLine <= last.endLine) {
      last.endLine = Math.max(last.endLine, endLine)
      last.offsets.push(m)
    } else {
      clusters.push({ startLine, endLine, offsets: [m] })
    }
  }

  return clusters.map(cluster => {
    const blockStart = lineOffsets[cluster.startLine - 1]!
    const blockEnd =
      cluster.endLine < lineOffsets.length
        ? lineOffsets[cluster.endLine]! - 1
        : content.length
    const block = content.slice(blockStart, blockEnd)
    let newBlock: string
    if (cluster.offsets.length > 1 || op.replaceAll) {
      newBlock = block.split(op.oldText).join(op.newText)
    } else {
      const rel = cluster.offsets[0]! - blockStart
      newBlock =
        block.slice(0, rel) + op.newText + block.slice(rel + op.oldText.length)
    }
    const edit: Record<string, unknown> = {
      op: 'replace',
      start: anchor(cluster.startLine),
      lines: newBlock,
    }
    if (cluster.endLine !== cluster.startLine) {
      edit.end = anchor(cluster.endLine)
    }
    return edit
  })
}

function computeLineOffsets(content: string): number[] {
  const offsets = [0]
  let i = content.indexOf('\n')
  while (i !== -1) {
    offsets.push(i + 1)
    i = content.indexOf('\n', i + 1)
  }
  return offsets
}

function lineForOffset(lineOffsets: number[], offset: number): number {
  let lo = 0
  let hi = lineOffsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineOffsets[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function assertNoOverlap(
  edits: Array<Record<string, unknown>>,
  filePath: string,
): void {
  const spans: Array<{ start: number; end: number }> = []
  for (const e of edits) {
    const lineOf = (v: unknown): number | undefined => {
      if (typeof v !== 'string') return undefined
      const line = Number(v.split(':')[0])
      return Number.isInteger(line) && line >= 0 ? line : undefined
    }
    const start = lineOf(e.start)
    if (start === undefined) continue
    const end = lineOf(e.end) ?? start
    spans.push({ start, end: Math.max(start, end) })
  }
  spans.sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start <= spans[i - 1]!.end) {
      throw new ToolInputCoercionError(
        `Overlapping spans in ${filePath}; legacy edits must touch each line at most once. Use edits[] with LINE:HASH anchors.`,
      )
    }
  }
}
