import { djb2Hash } from './hash.js'

const HASH_LEN = 3

// Label format: optional width digit, then a base36 hash of the trimmed
// context window [line-width .. line+width]. No width digit means width 1, so
// a line's hash covers the line and its two neighbors — that identifies a `}`
// or a blank line by where it sits, which content alone cannot. Read widens a
// colliding label to width 2 ("2" + hash), and width 2 is the cap: a repeated
// 5-line window stays ambiguous and errors like any duplicate did, and the cap
// bounds how far rewriting a line can invalidate anchors the model already
// holds (its neighbors' only).
const MAX_WIDTH = 2

/**
 * Short, stable content fingerprint. Trimmed per line so anchors survive
 * whitespace-only reformatting; unsigned base36, fixed width. djb2 is sync and
 * stable across runtimes (unlike Bun.hash / async xxhash).
 */
function shortHash(s: string): string {
  const h = (djb2Hash(s) >>> 0).toString(36)
  return h.slice(-HASH_LEN).padStart(HASH_LEN, '0')
}

/**
 * Neighbor lines outside a Read slice, needed because a slice-edge line's
 * context reaches past the slice. Absent entries mean the file boundary, so
 * labels computed from a slice match labels computed from the whole file.
 */
export type SliceContext = {
  /** Up to MAX_WIDTH lines above the slice, ordered nearest-last. */
  prevLines?: string[]
  /** Up to MAX_WIDTH lines below the slice, ordered nearest-first. */
  nextLines?: string[]
}

// Trimmed lines of the window around slice line i, clamped at the file
// boundary and extended into ctx past the slice edges.
function windowParts(
  lines: string[],
  i: number,
  width: number,
  ctx?: SliceContext,
): string[] {
  const parts: string[] = []
  for (let k = i - width; k <= i + width; k++) {
    let line: string | undefined
    if (k < 0) {
      line = ctx?.prevLines?.[(ctx?.prevLines?.length ?? 0) + k]
    } else if (k >= lines.length) {
      line = ctx?.nextLines?.[k - lines.length]
    } else {
      line = lines[k]
    }
    if (line !== undefined) parts.push(line.trim())
  }
  return parts
}

function windowHash(
  lines: string[],
  i: number,
  width: number,
  ctx?: SliceContext,
): string {
  return shortHash(windowParts(lines, i, width, ctx).join('\n'))
}

/**
 * One label per line: width 1 unless the window repeats in scope, then width 2
 * with "2" prefixed. Detection scope is the `lines` array (the whole file for
 * engine paths, the visible slice for Read), so an off-scope twin can still
 * surface later as an ambiguous-anchor error with candidates.
 */
function computeLabels(lines: string[], ctx?: SliceContext): string[] {
  const primary = lines.map((_, i) => windowHash(lines, i, 1, ctx))
  const seen = new Map<string, number>()
  for (const label of primary) {
    seen.set(label, (seen.get(label) ?? 0) + 1)
  }
  return primary.map((label, i) =>
    (seen.get(label) ?? 0) > 1 ? '2' + windowHash(lines, i, 2, ctx) : label,
  )
}

/**
 * Model-facing Read text format: one `LINE:HASH|content` per line. startLine is
 * 1-based. Mirrors addLineNumbers' line splitting so numbering stays aligned.
 */
export function formatHashline(
  content: string,
  startLine: number,
  ctx?: SliceContext,
): string {
  if (!content) return ''
  const lines = content.split(/\r?\n/)
  const labels = computeLabels(lines, ctx)
  return lines
    .map((line, i) => `${i + startLine}:${labels[i]}|${line}`)
    .join('\n')
}

// Strip a leading `N:hash|` anchor prefix from one line (inverse of formatHashline).
const HASHLINE_PREFIX = /^\s*\d+:[0-9a-z]+\|(.*)$/
export function stripHashlinePrefix(line: string): string {
  return line.match(HASHLINE_PREFIX)?.[1] ?? line
}

// line 0 / hash null = top-of-file insertion point.
export type Anchor = { line: number; hash: string | null }

/**
 * Split a label into its search window width and hash. Null for malformed
 * labels, which parseAnchor then rejects.
 */
function parseLabel(hash: string): { width: number; hash: string } | null {
  if (hash.length === HASH_LEN) return { width: 1, hash }
  if (hash.length === HASH_LEN + 1 && hash[0] === '2' && MAX_WIDTH >= 2) {
    return { width: 2, hash: hash.slice(1) }
  }
  return null
}

/**
 * Parse a `LINE:HASH` anchor. "12:a3f" → {12,"a3f"}, "0" → {0,null},
 * "12" → {12,null}. Returns null for malformed input.
 */
export function parseAnchor(s: string): Anchor | null {
  const trimmed = s.trim()
  const m = trimmed.match(/^(\d+)(?::([0-9a-z]+))?$/)
  if (!m) return null
  if (m[2] !== undefined && parseLabel(m[2]) === null) return null
  return { line: Number(m[1]), hash: m[2] ?? null }
}

// Flat shape matching the Edit tool's zod schema. The op-specific `lines`
// requirement is enforced at runtime in applyHashlineEdits (and by the schema's
// superRefine), so it stays optional here.
export type HashlineOp = {
  op: 'replace' | 'insert_after' | 'delete'
  start: string
  end?: string
  lines?: string
}

export type ApplyResult =
  | {
      ok: true
      updatedContent: string
      editCount: number
      /** Anchors placed by content because their line number had moved. */
      driftCount: number
    }
  | { ok: false; error: string }

// Normalized op resolved against the current file, with 1-based line range.
type ResolvedOp = {
  op: HashlineOp['op']
  startLine: number
  endLine: number
  lines: string | undefined
}

const WINDOW = 2

// Fresh anchors are quoted back on failure and after a successful edit. Both
// budgets bound what one tool result can add to the transcript.
const MAX_STALE_WINDOWS = 3
const MAX_REGION_ANCHOR_LINES = 60
const MAX_CANDIDATES_SHOWN = 8
const CANDIDATE_WINDOWS_PER_ANCHOR = 3

function freshWindow(fileLines: string[], line: number): string {
  const lo = Math.max(1, line - WINDOW)
  const hi = Math.min(fileLines.length, line + WINDOW)
  const out: string[] = []
  for (let n = lo; n <= hi; n++) {
    out.push(`${n}:${labelAt(fileLines, n)}|${fileLines[n - 1]}`)
  }
  return out.join('\n')
}

function fileLabel(filePath?: string): string {
  return filePath ? `file ${filePath}` : 'the file'
}

// One anchor that cannot be placed in the current content: no line carries its
// hash, or several lines do.
type StaleAnchor = {
  anchor: Anchor
  actual: string | null
  ambiguous: boolean
  /** Where the twins sit, for an ambiguous anchor. */
  candidates?: number[]
}

// A single-line replace/delete resolves start and end to the same anchor, so
// the batch report has to collapse them or it counts every one twice.
function addStale(
  stale: StaleAnchor[],
  anchor: Anchor,
  place: Exclude<Resolved, { kind: 'ok' }>,
): void {
  const text = anchorText(anchor)
  if (stale.some(s => anchorText(s.anchor) === text)) return
  stale.push({
    anchor,
    actual: place.actual,
    ambiguous: place.kind === 'ambiguous',
    candidates: place.kind === 'ambiguous' ? place.candidates : undefined,
  })
}

/**
 * One report for every stale anchor in the batch, so a re-anchored retry does
 * not have to discover them one rejection at a time.
 */
function staleAnchorError(
  stale: StaleAnchor[],
  fileLines: string[],
  filePath?: string,
): string {
  const label = fileLabel(filePath)
  const head =
    stale.length === 1
      ? `Anchor "${anchorText(stale[0]!.anchor)}" no longer matches ${label}.`
      : `${stale.length} anchors no longer match ${label}.`
  const detail = stale.map(s => {
    const name = anchorText(s.anchor)
    if (s.ambiguous) {
      const where = s.candidates
        ? ` — matching lines: ${s.candidates.slice(0, MAX_CANDIDATES_SHOWN).join(', ')}${s.candidates.length > MAX_CANDIDATES_SHOWN ? `, and ${s.candidates.length - MAX_CANDIDATES_SHOWN} more` : ''}`
        : ''
      return `  "${name}" → several lines carry that hash, so it cannot be placed by content${where}`
    }
    return s.actual === null
      ? `  "${name}" → the file now has ${fileLines.length} line(s)`
      : `  "${name}" → line ${s.anchor.line} is now "${s.anchor.line}:${s.actual}"`
  })
  const windows: string[] = []
  let omitted = 0
  for (const s of stale) {
    const at = s.ambiguous
      ? (s.candidates ?? []).slice(0, CANDIDATE_WINDOWS_PER_ANCHOR)
      : s.actual !== null
        ? [s.anchor.line]
        : []
    for (const line of at) {
      if (windows.length < MAX_STALE_WINDOWS)
        windows.push(freshWindow(fileLines, line))
      else omitted++
    }
  }
  return [
    `${head} The file changed since you read it.`,
    ...detail,
    ...(windows.length > 0
      ? [
          'Current content near the stale anchors:',
          windows.join('\n...\n'),
          ...(omitted > 0 ? [`... (${omitted} more not shown)`] : []),
        ]
      : []),
    'Re-read the file or use these anchors and retry.',
  ].join('\n')
}

function anchorText(anchor: Anchor): string {
  return anchor.hash === null
    ? String(anchor.line)
    : `${anchor.line}:${anchor.hash}`
}

/**
 * Anchored `LINE:HASH|content` blocks for 1-based line ranges of `content`,
 * separated by `...`. Used to hand back the anchors of the lines an edit just
 * wrote, so a follow-up edit needs no second Read.
 */
export function formatAnchoredRegions(
  content: string,
  regions: { start: number; count: number }[],
  ctx?: SliceContext,
): string {
  const fileLines = content.split('\n')
  const labels = computeLabels(fileLines, ctx)
  const blocks: string[] = []
  let budget = MAX_REGION_ANCHOR_LINES
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
      out.push(`${n}:${labels[n - 1]}|${fileLines[n - 1]}`)
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

/**
 * The best label for one 1-based line of the whole file: width 1, widened to
 * width 2 when its window repeats. Same rules computeLabels applies to a whole
 * file, for the small line sets error windows quote.
 */
function labelAt(fileLines: string[], line: number): string {
  const primary = windowHash(fileLines, line - 1, 1)
  for (let n = 0; n < fileLines.length; n++) {
    if (n !== line - 1 && windowHash(fileLines, n, 1) === primary) {
      return '2' + windowHash(fileLines, line - 1, 2)
    }
  }
  return primary
}

/** The label Read would have shown for the given 1-based line, for tests and
 * for callers that build anchors without formatting the whole file. */
export function anchorAt(content: string, line: number): string {
  return labelAt(content.split('\n'), line)
}

/** SliceContext for a slice starting at absolute startLine. Read plumbs the
 * real neighbors through SliceContext instead, so edge labels match. */
export function anchorContext(
  fullContent: string,
  sliceContent: string,
  startLine: number,
): SliceContext {
  const full = fullContent.split('\n')
  const sliceLines = sliceContent.split('\n')
  const lo0 = startLine - 1
  const ctx: SliceContext = {}
  if (lo0 > 0) {
    ctx.prevLines = full.slice(Math.max(0, lo0 - MAX_WIDTH), lo0)
  }
  if (lo0 + sliceLines.length < full.length) {
    ctx.nextLines = full.slice(
      lo0 + sliceLines.length,
      lo0 + sliceLines.length + MAX_WIDTH,
    )
  }
  return ctx
}

/**
 * Where an anchor points in the current content. A label names a line and the
 * line number is only a hint, because an edit above an anchor shifts it without
 * touching its content. A unique window is that line however far it moved, so
 * an anchor held across an earlier edit still works. A window that occurs
 * twice is no evidence at all, and no distance rule can make it so, so the
 * caller either takes a shift from a sibling anchor or refuses.
 */
type Resolved =
  | { kind: 'ok'; line: number; drifted: boolean }
  | { kind: 'missing'; actual: string | null }
  | { kind: 'ambiguous'; actual: string | null; candidates: number[] }

function labelAtLine(fileLines: string[], line: number): string | null {
  return line >= 1 && line <= fileLines.length ? labelAt(fileLines, line) : null
}

function resolveAnchor(fileLines: string[], anchor: Anchor): Resolved {
  // An anchor with no hash asks for a line number and nothing else. There is no
  // content to search for, so the only thing to check is that the line exists.
  if (anchor.hash === null) {
    return anchor.line >= 1 && anchor.line <= fileLines.length
      ? { kind: 'ok', line: anchor.line, drifted: false }
      : { kind: 'missing', actual: null }
  }
  const parsed = parseLabel(anchor.hash)!
  const actual = labelAtLine(fileLines, anchor.line)
  if (actual === anchor.hash) {
    return { kind: 'ok', line: anchor.line, drifted: false }
  }
  const candidates: number[] = []
  for (let n = 1; n <= fileLines.length; n++) {
    if (windowHash(fileLines, n - 1, parsed.width) !== parsed.hash) continue
    candidates.push(n)
    if (candidates.length > MAX_CANDIDATES_SHOWN * 2) break
  }
  if (candidates.length === 0) return { kind: 'missing', actual }
  if (candidates.length > 1) return { kind: 'ambiguous', actual, candidates }
  return { kind: 'ok', line: candidates[0]!, drifted: true }
}

// Place an ambiguous anchor with the shift a sibling anchor already proved.
function shiftAnchor(
  fileLines: string[],
  anchor: Anchor,
  delta: number,
): number | null {
  if (anchor.hash === null) return null
  const parsed = parseLabel(anchor.hash)
  if (!parsed) return null
  const line = anchor.line + delta
  return line >= 1 &&
    line <= fileLines.length &&
    windowHash(fileLines, line - 1, parsed.width) === parsed.hash
    ? line
    : null
}

/**
 * Apply hashline edits to file content. Pure: places each anchor in the current
 * content, rejects overlapping ranges, then applies edits by descending start
 * line so earlier splices don't shift later offsets. On any failure returns a
 * human-readable error that includes fresh `LINE:HASH|content` anchors so the
 * model can re-anchor.
 */
export function applyHashlineEdits(
  fileContent: string,
  edits: HashlineOp[],
  filePath?: string,
): ApplyResult {
  const fileLines = fileContent.split('\n')
  const resolved: ResolvedOp[] = []
  // Staleness is reported for the whole batch at once: a model that re-anchors
  // one edit at a time pays a rejection per anchor.
  const stale: StaleAnchor[] = []
  // Deduplicated, because a single-line op names the same anchor twice.
  const drifted = new Set<string>()

  for (const edit of edits) {
    const startAnchor = parseAnchor(edit.start)
    if (!startAnchor) {
      return {
        ok: false,
        error: `Invalid start anchor ${JSON.stringify(edit.start)} in ${fileLabel(
          filePath,
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
          filePath,
        )}. Anchors look like "LINE:HASH" (e.g. "12:a3f").`,
      }
    }

    // lines requirement (defense-in-depth; the schema also enforces this).
    const lines = edit.lines
    if (
      (edit.op === 'replace' || edit.op === 'insert_after') &&
      lines === undefined
    ) {
      return {
        ok: false,
        error: `The "${edit.op}" edit requires "lines" (the new text) in ${fileLabel(
          filePath,
        )}.`,
      }
    }

    // A malformed range is rejected outright. A line past the end of the file is
    // not one: the file may have shrunk under an anchor whose content only
    // moved, which resolution below handles.
    if (isInsert) {
      if (startAnchor.line < 0) {
        return {
          ok: false,
          error: `Insert anchor "${edit.start}" refers to line ${startAnchor.line} in ${fileLabel(
            filePath,
          )}. Use "0" to insert at the top.`,
        }
      }
    } else {
      if (startAnchor.line < 1 || endAnchor.line < 1) {
        return {
          ok: false,
          error: `Anchor range ${startAnchor.line}..${endAnchor.line} is invalid in ${fileLabel(
            filePath,
          )}. Lines are 1-based; "0" is only valid for insert_after.`,
        }
      }
      if (endAnchor.line < startAnchor.line) {
        return {
          ok: false,
          error: `End anchor line ${endAnchor.line} is before start anchor line ${startAnchor.line} in ${fileLabel(
            filePath,
          )}.`,
        }
      }
    }

    // Top-of-file insertion has no line to place.
    if (isInsert && startAnchor.line === 0) {
      resolved.push({ op: edit.op, startLine: 0, endLine: 0, lines })
      continue
    }

    let startPlace = resolveAnchor(fileLines, startAnchor)
    let endPlace =
      isInsert || endAnchor === startAnchor
        ? startPlace
        : resolveAnchor(fileLines, endAnchor)

    // One end places the other. A block that moved moved whole, so a unique
    // start hands an ambiguous end its exact shift. This is what lets a range
    // that ends on a line with a repeated window resolve at all, since such a
    // line can never be placed on its own.
    if (startPlace.kind === 'ok' && endPlace.kind === 'ambiguous') {
      const line = shiftAnchor(
        fileLines,
        endAnchor,
        startPlace.line - startAnchor.line,
      )
      if (line !== null) endPlace = { kind: 'ok', line, drifted: true }
    } else if (endPlace.kind === 'ok' && startPlace.kind === 'ambiguous') {
      const line = shiftAnchor(
        fileLines,
        startAnchor,
        endPlace.line - endAnchor.line,
      )
      if (line !== null) startPlace = { kind: 'ok', line, drifted: true }
    }

    if (startPlace.kind !== 'ok' || endPlace.kind !== 'ok') {
      if (startPlace.kind !== 'ok') {
        addStale(stale, startAnchor, startPlace)
      }
      if (endPlace.kind !== 'ok') {
        addStale(stale, endAnchor, endPlace)
      }
      continue
    }

    // Both ends must have moved by the same amount. If they did not, lines were
    // added or removed inside the range and it no longer means what it did.
    if (!isInsert) {
      const anchored = endAnchor.line - startAnchor.line
      const placed = endPlace.line - startPlace.line
      if (placed !== anchored) {
        return {
          ok: false,
          error: [
            `The range "${anchorText(startAnchor)}".."${anchorText(
              endAnchor,
            )}" covered ${anchored + 1} line(s), but its ends now sit at lines ${startPlace.line} and ${endPlace.line} in ${fileLabel(filePath)}.`,
            'Lines were added or removed inside it.',
            'Current content at each end:',
            freshWindow(fileLines, startPlace.line),
            '...',
            freshWindow(fileLines, endPlace.line),
            'Re-read the file or use these anchors and retry.',
          ].join('\n'),
        }
      }
    }

    if (startPlace.drifted) drifted.add(anchorText(startAnchor))
    if (endPlace.drifted) drifted.add(anchorText(endAnchor))

    resolved.push({
      op: edit.op,
      startLine: startPlace.line,
      endLine: isInsert ? startPlace.line : endPlace.line,
      lines,
    })
  }

  if (stale.length > 0) {
    return { ok: false, error: staleAnchorError(stale, fileLines, filePath) }
  }

  // Overlap detection. insert_after at line N is modeled as the point [N, N];
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
          filePath,
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

  // split('\n')/join('\n') is its own inverse: a trailing newline survives as a
  // trailing empty element, so it is preserved iff the original had one.
  return {
    ok: true,
    updatedContent: newLines.join('\n'),
    editCount: edits.length,
    driftCount: drifted.size,
  }
}
