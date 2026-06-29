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
  | { ok: true; updatedContent: string; editCount: number }
  | { ok: false; error: string }

// Normalized op resolved against the current file, with 1-based line range.
type ResolvedOp = {
  op: HashlineOp['op']
  startLine: number
  endLine: number
  lines: string | undefined
}

const WINDOW = 2

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

/**
 * Apply hashline edits to file content. Pure: validates each anchor's recomputed
 * hash against the current content (the staleness guard), rejects overlapping
 * ranges, then applies edits by descending start line so earlier splices don't
 * shift later offsets. On any failure returns a human-readable error that
 * includes fresh `LINE:HASH|content` anchors so the model can re-anchor.
 */
export function applyHashlineEdits(
  fileContent: string,
  edits: HashlineOp[],
  filePath?: string,
): ApplyResult {
  const fileLines = fileContent.split('\n')
  const resolved: ResolvedOp[] = []

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

    // Range validation.
    if (isInsert) {
      // insert_after: start line 0 = top; otherwise must be an existing line.
      if (startAnchor.line < 0 || startAnchor.line > fileLines.length) {
        return {
          ok: false,
          error: `Insert anchor "${edit.start}" refers to line ${startAnchor.line}, but ${fileLabel(
            filePath,
          )} has ${fileLines.length} line(s). Use "0" to insert at the top.`,
        }
      }
    } else {
      if (
        startAnchor.line < 1 ||
        startAnchor.line > fileLines.length ||
        endAnchor.line < 1 ||
        endAnchor.line > fileLines.length
      ) {
        return {
          ok: false,
          error: `Anchor range ${startAnchor.line}..${endAnchor.line} is out of bounds; ${fileLabel(
            filePath,
          )} has ${fileLines.length} line(s). Re-read the file for current anchors.`,
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

    // Hash (staleness) validation for anchored lines.
    const anchorsToCheck: Anchor[] = isInsert
      ? startAnchor.line === 0
        ? []
        : [startAnchor]
      : [startAnchor, endAnchor]
    for (const anchor of anchorsToCheck) {
      if (anchor.hash === null) continue
      const actual = hashLine(fileLines[anchor.line - 1])
      if (actual !== anchor.hash) {
        return {
          ok: false,
          error: `Anchor "${anchor.line}:${anchor.hash}" no longer matches ${fileLabel(
            filePath,
          )} (line ${anchor.line} is now "${anchor.line}:${actual}"). The file changed since you read it. Current content near line ${anchor.line}:\n${freshWindow(
            fileLines,
            anchor.line,
          )}\nRe-read the file or use these anchors and retry.`,
        }
      }
    }

    resolved.push({
      op: edit.op,
      startLine: startAnchor.line,
      endLine: isInsert ? startAnchor.line : endAnchor.line,
      lines,
    })
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
  }
}
