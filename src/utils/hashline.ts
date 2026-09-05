import type { AppliedPatch } from './editState.js'
import { djb2Hash } from './hash.js'

// Labels are `LINE:HASH|content`. HASH fingerprints the trimmed line together
// with its line number: no neighbor context, no widening-by-window. An anchor
// is an assertion "line LINE of the snapshot you were shown has this content",
// and resolution either matches that assertion against the current content or
// remaps it through the patches this response already applied.

const MIN_HASH_LEN = 3
const MAX_HASH_LEN = 6
const FULL_HASH_LEN = 8
const COLLISION_PROBABILITY = 0.01

/**
 * Birthday-bound hash length: with one label per line, a truncated collision
 * anywhere in an n-line file is expected once n²/(2·36^L) passes the budget.
 * Pick the smallest length that stays under it.
 */
export function hashLengthForLineCount(
  lineCount: number,
  probability: number = COLLISION_PROBABILITY,
): number {
  for (let length = MIN_HASH_LEN; length <= MAX_HASH_LEN; length++) {
    if (lineCount * lineCount < 2 * probability * 36 ** length) {
      return length
    }
  }
  return MAX_HASH_LEN
}

/** Base-36 djb2 of trimmed content + line number, 8 chars, fixed width. */
function fullFingerprint(line: string, lineNo: number): string {
  const h = djb2Hash(`${line.trim()}\n${lineNo}`) >>> 0
  return h.toString(36).padStart(FULL_HASH_LEN, '0').slice(-FULL_HASH_LEN)
}

export type HashlineLabel = {
  hash: string
  /**
   * Lines whose full fingerprint still shares it with another line: their
   * anchors cannot be verified safely and are rejected as `label collision`.
   */
  collision: boolean
}

export type HashlineLabelSet = {
  /** The file-wide base length; most labels use it. */
  length: number
  labels: HashlineLabel[]
}

/**
 * One label per line of the whole file. Lines whose truncated hash collides
 * with another line get a longer label (L+2, then the full fingerprint) — the
 * only collision remedy; nothing about the line's neighbors is consulted.
 */
export function computeHashlineLabels(content: string): HashlineLabelSet {
  if (!content) return { length: hashLengthForLineCount(0), labels: [] }
  const lines = content.split(/\r?\n/)
  const baseLength = hashLengthForLineCount(lines.length)
  const fps = lines.map((line, i) => fullFingerprint(line, i + 1))

  const groupBy = (len: number, indices: number[]): Map<string, number[]> => {
    const groups = new Map<string, number[]>()
    for (const i of indices) {
      const key = fps[i]!.slice(-len)
      const group = groups.get(key)
      if (group) group.push(i)
      else groups.set(key, [i])
    }
    return groups
  }

  const all = lines.map((_, i) => i)
  const labels: HashlineLabel[] = fps.map(hash => ({
    hash: hash.slice(-baseLength),
    collision: false,
  }))

  for (const group of groupBy(baseLength, all).values()) {
    if (group.length === 1) continue
    resolveCollisionGroup(group, baseLength, fps, labels, groupBy)
  }
  return { length: baseLength, labels }
}

// Widening ladder for a group of lines sharing a truncated hash: L+2, then
// the full fingerprint; only a full-fingerprint twin leaves lines unusable.
function resolveCollisionGroup(
  group: number[],
  baseLength: number,
  fps: string[],
  labels: HashlineLabel[],
  groupBy: (len: number, indices: number[]) => Map<string, number[]>,
): void {
  let pending: number[][] = [group]
  let len = Math.min(baseLength + 2, FULL_HASH_LEN)
  while (pending.length > 0) {
    const next: number[][] = []
    for (const cluster of pending) {
      for (const sub of groupBy(len, cluster).values()) {
        if (sub.length === 1) {
          labels[sub[0]!] = {
            hash: fps[sub[0]!]!.slice(-len),
            collision: false,
          }
        } else if (len >= FULL_HASH_LEN) {
          for (const i of sub) {
            labels[i] = { hash: fps[i]!, collision: true }
          }
        } else {
          next.push(sub)
        }
      }
    }
    if (len >= FULL_HASH_LEN) break
    len = FULL_HASH_LEN
    pending = next
  }
}

// All line labels as display strings, whole-file scope.
function labelStrings(labelSet: HashlineLabelSet): string[] {
  return labelSet.labels.map(l => l.hash)
}

/**
 * Model-facing `LINE:HASH|content` lines. Labels always cover the whole file,
 * then the optional range selects displayed rows, so a slice's labels are the
 * same strings the full file shows for those lines.
 */
export function formatHashline(
  content: string,
  range?: { startLine?: number; lineCount?: number },
): string {
  if (!content) return ''
  const lines = content.split(/\r?\n/)
  const labels = labelStrings(computeHashlineLabels(content))
  const start = Math.max(1, range?.startLine ?? 1)
  const maxCount = Math.max(0, lines.length - start + 1)
  const count = Math.min(range?.lineCount ?? maxCount, maxCount)
  const out: string[] = []
  for (let i = start - 1; i < start - 1 + count; i++) {
    out.push(`${i + 1}:${labels[i]}|${lines[i]}`)
  }
  return out.join('\n')
}

// Strip a leading `LINE:HASH|` anchor prefix (inverse of formatHashline).
// 3-8 char hashes: any length a label can use.
const HASHLINE_PREFIX = /^\s*\d+:[0-9a-z]{3,8}\|(.*)$/
export function stripHashlinePrefix(line: string): string {
  return line.match(HASHLINE_PREFIX)?.[1] ?? line
}

// line 0 / hash null = top-of-file insertion point.
export type Anchor = { line: number; hash: string | null }

/**
 * Parse a `LINE:HASH` anchor. "12:a3f" → {12,"a3f"}, "0" → {0,null},
 * "12" → {12,null}. Returns null for malformed input. Hash lengths 3-8 are
 * accepted; only "0" may omit the hash when applying (positive bare line
 * numbers bypass the assertion model and are rejected at resolution).
 */
export function parseAnchor(s: string): Anchor | null {
  const trimmed = s.trim()
  const m = trimmed.match(/^(\d+)(?::([0-9a-z]{3,8}))?$/)
  if (!m) return null
  return { line: Number(m[1]), hash: m[2] ?? null }
}

/** The label a Read would show for one 1-based line of the whole file. */
export function anchorAt(content: string, line: number): string {
  const labelSet = computeHashlineLabels(content)
  return labelSet.labels[line - 1]?.hash ?? ''
}

export type HashlineOp = {
  op: 'replace' | 'insert_after' | 'delete'
  start: string
  end?: string
  lines?: string
}

export type ResolutionContext = {
  filePath?: string
  /** The content the model's anchors were minted against, if known. */
  baselineContent?: string
  /** Patches this response already applied, in chronological order. */
  patches?: readonly AppliedPatch[]
  /** Set when remapping is unsafe (external change, bookkeeping cap). */
  remapUnavailableReason?: string
}

export type ApplyResult =
  | {
      ok: true
      updatedContent: string
      editCount: number
      /**
       * Splices this call applied, in chronological order, each in the
       * coordinate space of the document just before that splice.
       */
      appliedPatches: AppliedPatch[]
      lineDelta: number
    }
  | { ok: false; error: string }

// Normalized op resolved against the current file, 1-based inclusive range.
type ResolvedOp = {
  op: HashlineOp['op']
  startLine: number
  endLine: number
  lines: string | undefined
}

const WINDOW = 1

const MAX_STALE_WINDOWS = 3

function freshWindow(fileLines: string[], line: number): string {
  const labels = labelStrings(computeHashlineLabels(fileLines.join('\n')))
  const lo = Math.max(1, line - WINDOW)
  const hi = Math.min(fileLines.length, line + WINDOW)
  const out: string[] = []
  for (let n = lo; n <= hi; n++) {
    out.push(`${n}:${labels[n - 1] ?? ''}|${fileLines[n - 1]}`)
  }
  return out.join('\n')
}

function fileLabel(filePath?: string): string {
  return filePath ? `file ${filePath}` : 'the file'
}

function anchorText(anchor: Anchor): string {
  return anchor.hash === null
    ? String(anchor.line)
    : `${anchor.line}:${anchor.hash}`
}

type StaleReason =
  | 'content-mismatch'
  | 'out-of-bounds'
  | 'consumed'
  | 'collision'
  | 'baseline-mismatch'
  | 'no-baseline'

type StaleAnchor = {
  anchor: Anchor
  reason: StaleReason
  /** Where to show a fresh ±1 window: anchor line clamped to current file. */
  windowAt?: number
}

function staleReasonText(
  reason: StaleReason,
  anchor: Anchor,
  fileLineCount: number,
): string {
  switch (reason) {
    case 'content-mismatch':
      return `line ${anchor.line} content differs now`
    case 'out-of-bounds':
      return `that line is outside the current file (${fileLineCount} line(s))`
    case 'consumed':
      return "the anchor's line was rewritten by an earlier edit in this message"
    case 'collision':
      return 'label collision; this line cannot be verified safely'
    case 'baseline-mismatch':
      return 'this anchor does not match the snapshot used for this response'
    case 'no-baseline':
      return 'line content differs now and no snapshot is available to remap it'
  }
}

function staleAnchorError(
  stale: StaleAnchor[],
  fileLines: string[],
  extra: string[] = [],
): string {
  const detail = stale.map(
    s =>
      `  "${anchorText(s.anchor)}" → ${staleReasonText(
        s.reason,
        s.anchor,
        fileLines.length,
      )}`,
  )
  const windows: string[] = []
  let omitted = 0
  for (const s of stale) {
    if (s.windowAt === undefined) continue
    if (windows.length < MAX_STALE_WINDOWS)
      windows.push(freshWindow(fileLines, s.windowAt))
    else omitted++
  }
  return [
    'Anchor validation failed. The file no longer matches the snapshot these anchors were taken from.',
    ...detail,
    ...extra,
    ...(windows.length > 0
      ? [
          'Current content near the affected lines:',
          windows.join('\n...\n'),
          ...(omitted > 0 ? [`... (${omitted} more not shown)`] : []),
        ]
      : []),
    'Re-read the file or use the anchors above.',
  ].join('\n')
}

/**
 * Map one baseline line through chronological patches to the current document.
 * Returns the mapped line, or null when a positive-length patch consumed it.
 */
function mapLine(
  baselineLine: number,
  patches: readonly AppliedPatch[],
): number | null {
  let line = baselineLine
  for (const p of patches) {
    if (p.oldLen === 0) {
      if (line >= p.oldStart) line += p.newLen
      continue
    }
    const oldEnd = p.oldStart + p.oldLen - 1
    if (line < p.oldStart) continue
    if (line <= oldEnd) return null
    line += p.newLen - p.oldLen
  }
  return line
}

type RangeMap =
  | { kind: 'ok'; startLine: number; endLine: number }
  | { kind: 'consumed' }
  | { kind: 'inside' }

/**
 * Map a baseline range, rejecting any range an earlier patch consumed or
 * reached inside — the range's meaning dies if any line inside it moved.
 */
function mapRange(
  start: number,
  end: number,
  patches: readonly AppliedPatch[],
): RangeMap {
  let s = start
  let e = end
  for (const p of patches) {
    if (p.oldLen === 0) {
      if (p.oldStart <= s) {
        s += p.newLen
        e += p.newLen
      } else if (p.oldStart <= e) {
        return { kind: 'inside' }
      }
      continue
    }
    const patchEnd = p.oldStart + p.oldLen - 1
    if (patchEnd < s) {
      const d = p.newLen - p.oldLen
      s += d
      e += d
    } else if (p.oldStart > e) {
      continue
    } else {
      return s >= p.oldStart && e <= patchEnd
        ? { kind: 'consumed' }
        : { kind: 'inside' }
    }
  }
  return { kind: 'ok', startLine: s, endLine: e }
}

type Placement = { line: number } | { reason: StaleReason; windowAt?: number }

function isPlacementMoved(p: Placement): p is { line: number } {
  return 'line' in p
}

/**
 * Place one anchor: Tier 1 asserts against the current file directly; Tier 2
 * verifies the response baseline and maps through the applied patches. The
 * post-map check compares whole lines, because the anchor's hash covers the
 * baseline line number, which a shift necessarily changes.
 */
function placeAnchor(
  anchor: Anchor,
  currentLines: string[],
  currentLabels: string[],
  baseline: { lines: string[]; labels: string[] } | null,
  patches: readonly AppliedPatch[],
  currentLabelCollisions: boolean[],
  baselineCollisions: boolean[],
): Placement {
  if (anchor.line >= 1 && anchor.line <= currentLines.length) {
    if (
      !currentLabelCollisions[anchor.line - 1] &&
      currentLabels[anchor.line - 1] === anchor.hash
    ) {
      return { line: anchor.line }
    }
  }
  if (!baseline) {
    return {
      reason:
        anchor.line > currentLines.length ? 'out-of-bounds' : 'no-baseline',
      windowAt: anchor.line,
    }
  }
  if (anchor.line < 1 || anchor.line > baseline.lines.length) {
    return { reason: 'out-of-bounds', windowAt: anchor.line }
  }
  if (baselineCollisions[anchor.line - 1]) {
    return { reason: 'collision', windowAt: anchor.line }
  }
  if (baseline.labels[anchor.line - 1] !== anchor.hash) {
    return { reason: 'baseline-mismatch', windowAt: anchor.line }
  }
  const mapped = mapLine(anchor.line, patches)
  if (mapped === null) {
    return { reason: 'consumed', windowAt: anchor.line }
  }
  if (mapped < 1 || mapped > currentLines.length) {
    return { reason: 'out-of-bounds', windowAt: mapped }
  }
  if (currentLines[mapped - 1] !== baseline.lines[anchor.line - 1]) {
    return { reason: 'content-mismatch', windowAt: mapped }
  }
  return { line: mapped }
}

/**
 * Apply hashline edits to file content. Pure: places each anchor against the
 * current content (or remaps it through the context's baseline + patches),
 * rejects overlapping ranges, then applies edits by descending start line.
 * On failure the error names every stale anchor and quotes fresh ±1 windows.
 */
export function applyHashlineEdits(
  fileContent: string,
  edits: HashlineOp[],
  context?: ResolutionContext,
): ApplyResult {
  const fileLines = fileContent.split(/\r?\n/)
  const currentLabelSet = computeHashlineLabels(fileContent)
  const currentLabels = labelStrings(currentLabelSet)
  const currentCollisions = currentLabelSet.labels.map(l => l.collision)

  // Remap unavailable (external change, patch cap): exact anchors still
  // resolve, but nothing below Tier 1 may be trusted.
  const remapNote = context?.remapUnavailableReason
  const baseline =
    !remapNote && context?.baselineContent !== undefined
      ? (() => {
          const set = computeHashlineLabels(context.baselineContent!)
          return {
            lines: context.baselineContent!.split(/\r?\n/),
            labels: labelStrings(set),
            collisions: set.labels.map(l => l.collision),
          }
        })()
      : null
  const patches = remapNote ? [] : (context?.patches ?? [])

  const resolved: ResolvedOp[] = []
  const stale: StaleAnchor[] = []
  const extras: string[] = []

  const addStale = (anchor: Anchor, place: Placement): void => {
    if (isPlacementMoved(place)) return
    const text = anchorText(anchor)
    if (stale.some(s => anchorText(s.anchor) === text)) return
    stale.push({ anchor, reason: place.reason, windowAt: place.windowAt })
  }

  for (const edit of edits) {
    const startAnchor = parseAnchor(edit.start)
    if (!startAnchor) {
      return {
        ok: false,
        error: `Invalid start anchor ${JSON.stringify(edit.start)} in ${fileLabel(
          context?.filePath,
        )}. Anchors look like "LINE:HASH" (e.g. "12:a3f") or "0" for the top of the file.`,
      }
    }

    const isInsert = edit.op === 'insert_after'
    const endRaw = !isInsert ? edit.end : undefined
    const endAnchor =
      endRaw !== undefined && endRaw !== '' ? parseAnchor(endRaw) : startAnchor
    if (!endAnchor) {
      return {
        ok: false,
        error: `Invalid end anchor ${JSON.stringify(endRaw)} in ${fileLabel(
          context?.filePath,
        )}. Anchors look like "LINE:HASH" (e.g. "12:a3f").`,
      }
    }

    if (startAnchor.hash === null && startAnchor.line !== 0) {
      return {
        ok: false,
        error: `Anchor "${edit.start}" has no hash. Anchors must be copied from Read output as "LINE:HASH" (only "0" may omit the hash, for inserting at the top).${
          remapNote ? `\n${remapNote}` : ''
        }`,
      }
    }

    const lines = edit.lines
    if (
      (edit.op === 'replace' || edit.op === 'insert_after') &&
      lines === undefined
    ) {
      return {
        ok: false,
        error: `The "${edit.op}" edit requires "lines" (the new text) in ${fileLabel(
          context?.filePath,
        )}.`,
      }
    }

    if (isInsert) {
      if (startAnchor.line < 0) {
        return {
          ok: false,
          error: `Insert anchor "${edit.start}" refers to line ${startAnchor.line} in ${fileLabel(
            context?.filePath,
          )}. Use "0" to insert at the top.`,
        }
      }
    } else {
      if (startAnchor.line < 1 || endAnchor.line < 1) {
        return {
          ok: false,
          error: `Anchor range ${startAnchor.line}..${endAnchor.line} is invalid in ${fileLabel(
            context?.filePath,
          )}. Lines are 1-based; "0" is only valid for insert_after.`,
        }
      }
      if (endAnchor.line < startAnchor.line) {
        return {
          ok: false,
          error: `End anchor line ${endAnchor.line} is before start anchor line ${startAnchor.line} in ${fileLabel(
            context?.filePath,
          )}.`,
        }
      }
    }

    if (isInsert && startAnchor.line === 0) {
      resolved.push({ op: edit.op, startLine: 0, endLine: 0, lines })
      continue
    }

    let startPlace = placeAnchor(
      startAnchor,
      fileLines,
      currentLabels,
      baseline,
      patches,
      currentCollisions,
      baseline ? baseline.collisions : [],
    )

    if (isInsert || endAnchor === startAnchor) {
      if (!isPlacementMoved(startPlace)) {
        addStale(startAnchor, startPlace)
        continue
      }
      if (startPlace.line > fileLines.length) {
        addStale(startAnchor, {
          reason: 'out-of-bounds',
          windowAt: startPlace.line,
        })
        continue
      }
      resolved.push({
        op: edit.op,
        startLine: startPlace.line,
        endLine: startPlace.line,
        lines,
      })
      continue
    }

    const endPlace = placeAnchor(
      endAnchor,
      fileLines,
      currentLabels,
      baseline,
      patches,
      currentCollisions,
      baseline ? baseline.collisions : [],
    )

    if (!isPlacementMoved(startPlace) || !isPlacementMoved(endPlace)) {
      addStale(startAnchor, startPlace)
      addStale(endAnchor, endPlace)
      continue
    }

    if (endPlace.line < startPlace.line) {
      extras.push(
        `Range "${anchorText(startAnchor)}".."${anchorText(
          endAnchor,
        )}" ends before it starts after remapping.`,
      )
      continue
    }

    // With patches in play, map the whole range: any earlier splice that fell
    // inside (or consumed) it means the range no longer means one block.
    if (patches.length > 0 && baseline) {
      const mapped = mapRange(startAnchor.line, endAnchor.line, patches)
      if (mapped.kind === 'consumed') {
        addStale(startAnchor, {
          reason: 'consumed',
          windowAt: startAnchor.line,
        })
        continue
      }
      if (mapped.kind === 'inside') {
        extras.push(
          `Range "${anchorText(startAnchor)}".."${anchorText(
            endAnchor,
          )}" was changed by an earlier edit in this message.`,
        )
        continue
      }
      if (
        mapped.startLine !== startPlace.line ||
        mapped.endLine !== endPlace.line
      ) {
        extras.push(
          `Range "${anchorText(startAnchor)}".."${anchorText(
            endAnchor,
          )}" no longer covers one block of lines.`,
        )
        continue
      }
    }

    resolved.push({
      op: edit.op,
      startLine: startPlace.line,
      endLine: endPlace.line,
      lines,
    })
  }

  if (stale.length > 0 || extras.length > 0) {
    if (remapNote) extras.unshift(remapNote)
    return { ok: false, error: staleAnchorError(stale, fileLines, extras) }
  }

  // Overlap detection. insert_after at line N is the point [N, N];
  // replace/delete cover [start, end]. Any shared line is a conflict.
  const sortedForOverlap = [...resolved].sort(
    (a, b) => a.startLine - b.startLine,
  )
  for (let i = 1; i < sortedForOverlap.length; i++) {
    const prev = sortedForOverlap[i - 1]
    const cur = sortedForOverlap[i]
    if (cur.startLine <= prev.endLine) {
      return {
        ok: false,
        error: `Edits overlap: ranges ${prev.startLine}..${prev.endLine} and ${cur.startLine}..${cur.endLine} in ${fileLabel(
          context?.filePath,
        )} touch the same line(s). Split them so each line is edited at most once.`,
      }
    }
  }

  // Apply by descending start line so lower offsets are not shifted.
  const newLines = [...fileLines]
  const ordered = [...resolved].sort((a, b) => b.startLine - a.startLine)
  for (const r of ordered) {
    if (r.op === 'insert_after') {
      newLines.splice(r.startLine, 0, ...(r.lines ?? '').split('\n'))
    } else if (r.op === 'delete') {
      newLines.splice(r.startLine - 1, r.endLine - r.startLine + 1)
    } else {
      newLines.splice(
        r.startLine - 1,
        r.endLine - r.startLine + 1,
        ...(r.lines ?? '').split('\n'),
      )
    }
  }

  const appliedPatches = coalescePatches(
    resolved
      .map(r => {
        if (r.op === 'insert_after') {
          return {
            // Top-of-file insertion resolved at line 0 lands here as
            // insert-after-line-0 below; both are insertions before oldStart.
            oldStart: r.startLine + 1,
            oldLen: 0,
            newLen: (r.lines ?? '').split('\n').length,
          }
        }
        return {
          oldStart: r.startLine,
          oldLen: r.endLine - r.startLine + 1,
          newLen: r.op === 'delete' ? 0 : (r.lines ?? '').split('\n').length,
        }
      })
      .sort((a, b) => a.oldStart - b.oldStart),
  )

  const lineDelta = appliedPatches.reduce(
    (sum, p) => sum + p.newLen - p.oldLen,
    0,
  )

  return {
    ok: true,
    updatedContent: newLines.join('\n'),
    editCount: edits.length,
    appliedPatches,
    lineDelta,
  }
}

// Merge contiguous same-kind splices (same coordinate space: one apply run)
// so the response patch list stays small. Never merge an insertion with a
// positive-length range: that would mark untouched lines as consumed.
function coalescePatches(patches: AppliedPatch[]): AppliedPatch[] {
  const merged: AppliedPatch[] = []
  for (const p of patches) {
    const last = merged[merged.length - 1]
    if (
      last &&
      ((last.oldLen === 0 && p.oldLen === 0 && p.oldStart === last.oldStart) ||
        (last.oldLen > 0 &&
          p.oldLen > 0 &&
          p.oldStart === last.oldStart + last.oldLen))
    ) {
      last.newLen += p.newLen
      last.oldLen += p.oldLen
    } else {
      merged.push({ ...p })
    }
  }
  return merged
}

/**
 * Anchored `LINE:HASH|content` blocks for 1-based line ranges of `content`,
 * separated by `...`. Hands back the anchors of the lines an edit just wrote,
 * so a follow-up edit needs no second Read.
 */
export function formatAnchoredRegions(
  content: string,
  regions: readonly { start: number; count: number }[],
): string {
  const fileLines = content.split(/\r?\n/)
  const labels = labelStrings(computeHashlineLabels(content))
  const blocks: string[] = []
  const budgetMax = 60
  let budget = budgetMax
  let truncated = false
  for (const region of regions) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const lo = Math.max(1, region.start)
    const hi = Math.min(fileLines.length, region.start + region.count - 1)
    const out: string[] = []
    for (let n = lo; n <= hi && budget > 0; n++) {
      out.push(`${n}:${labels[n - 1] ?? ''}|${fileLines[n - 1]}`)
      budget--
    }
    if (hi - lo + 1 > out.length) truncated = true
    if (out.length > 0) blocks.push(out.join('\n'))
  }
  if (blocks.length === 0) return ''
  return truncated
    ? `${blocks.join('\n...\n')}\n... (more changed lines not shown — Read the file for their anchors)`
    : blocks.join('\n...\n')
}

/** @deprecated Kept for existing imports; SliceContext no longer affects labels. */
export type SliceContext = Record<string, never>
