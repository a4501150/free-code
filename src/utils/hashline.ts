import { djb2Hash } from './hash.js'

const HASH_LEN = 3

/**
 * Short, stable content fingerprint for a single line. Trimmed so anchors
 * survive whitespace-only reformatting; unsigned base36, fixed width. djb2 is
 * sync and stable across runtimes (unlike Bun.hash / async xxhash).
 */
export function hashLine(line: string): string {
  const h = (djb2Hash(line.trim()) >>> 0).toString(36)
  return h.slice(-HASH_LEN).padStart(HASH_LEN, '0')
}

/**
 * Model-facing Read text format: one `LINE:HASH|content` per line. startLine is
 * 1-based. Mirrors addLineNumbers' line splitting so numbering stays aligned.
 */
export function formatHashline(content: string, startLine: number): string {
  if (!content) return ''
  return content
    .split(/\r?\n/)
    .map((line, i) => `${i + startLine}:${hashLine(line)}|${line}`)
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
 * Parse a `LINE:HASH` anchor. "12:a3f" → {12,"a3f"}, "0" → {0,null},
 * "12" → {12,null}. Returns null for malformed input.
 */
export function parseAnchor(s: string): Anchor | null {
  const trimmed = s.trim()
  const m = trimmed.match(/^(\d+)(?::([0-9a-z]+))?$/)
  if (!m) return null
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

function freshWindow(fileLines: string[], line: number): string {
  const lo = Math.max(1, line - WINDOW)
  const hi = Math.min(fileLines.length, line + WINDOW)
  const out: string[] = []
  for (let n = lo; n <= hi; n++) {
    out.push(`${n}:${hashLine(fileLines[n - 1])}|${fileLines[n - 1]}`)
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
}

// A single-line replace/delete resolves start and end to the same anchor, so
// the batch report has to collapse them or it counts every one twice.
function addStale(
  stale: StaleAnchor[],
  anchor: Anchor,
  actual: string | null,
  ambiguous: boolean,
): void {
  const text = anchorText(anchor)
  if (stale.some(s => anchorText(s.anchor) === text)) return
  stale.push({ anchor, actual, ambiguous })
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
      return `  "${name}" → several lines carry that hash, so it cannot be placed by content`
    }
    return s.actual === null
      ? `  "${name}" → the file now has ${fileLines.length} line(s)`
      : `  "${name}" → line ${s.anchor.line} is now "${s.anchor.line}:${s.actual}"`
  })
  const inRange = stale
    .filter(s => s.actual !== null)
    .slice(0, MAX_STALE_WINDOWS)
  const windows = inRange.map(s => freshWindow(fileLines, s.anchor.line))
  const omitted = stale.filter(s => s.actual !== null).length - inRange.length
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
): string {
  const fileLines = content.split('\n')
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
      out.push(`${n}:${hashLine(fileLines[n - 1])}|${fileLines[n - 1]}`)
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
 * Where an anchor points in the current content. A hash names a line and the
 * line number is only a hint, because an edit above an anchor shifts it without
 * touching its content.
 */
type Resolved =
  | { kind: 'ok'; line: number; drifted: boolean }
  | { kind: 'missing'; actual: string | null }
  | { kind: 'ambiguous'; actual: string | null }

function hashAt(fileLines: string[], line: number): string | null {
  return line >= 1 && line <= fileLines.length
    ? hashLine(fileLines[line - 1])
    : null
}

/**
 * Place an anchor: its own line first, then the whole file. A hash that occurs
 * once is that line however far it moved, so an anchor held across an earlier
 * edit still works. A hash that occurs twice is no evidence at all, and no
 * distance rule can make it so, so the caller either takes a shift from a
 * sibling anchor or refuses. A blank line is never a candidate, because its
 * hash identifies nothing.
 */
function resolveAnchor(fileLines: string[], anchor: Anchor): Resolved {
  // An anchor with no hash asks for a line number and nothing else. There is no
  // content to search for, so the only thing to check is that the line exists.
  if (anchor.hash === null) {
    return anchor.line >= 1 && anchor.line <= fileLines.length
      ? { kind: 'ok', line: anchor.line, drifted: false }
      : { kind: 'missing', actual: null }
  }
  const actual = hashAt(fileLines, anchor.line)
  if (actual === anchor.hash) {
    return { kind: 'ok', line: anchor.line, drifted: false }
  }
  let found = 0
  for (let n = 1; n <= fileLines.length; n++) {
    const line = fileLines[n - 1]
    if (line.trim() === '' || hashLine(line) !== anchor.hash) continue
    if (found !== 0) return { kind: 'ambiguous', actual }
    found = n
  }
  return found === 0
    ? { kind: 'missing', actual }
    : { kind: 'ok', line: found, drifted: true }
}

// Place an ambiguous anchor with the shift a sibling anchor already proved.
function shiftAnchor(
  fileLines: string[],
  anchor: Anchor,
  delta: number,
): number | null {
  if (anchor.hash === null) return null
  const line = anchor.line + delta
  return hashAt(fileLines, line) === anchor.hash ? line : null
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
    // that ends on a line like "}" resolve at all, since such a line has twins
    // everywhere and can never be placed on its own.
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
        addStale(
          stale,
          startAnchor,
          startPlace.actual,
          startPlace.kind === 'ambiguous',
        )
      }
      if (endPlace.kind !== 'ok') {
        addStale(
          stale,
          endAnchor,
          endPlace.actual,
          endPlace.kind === 'ambiguous',
        )
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
