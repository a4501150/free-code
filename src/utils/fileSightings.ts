/**
 * Content sightings: records which lines of which files the model was actually
 * SHOWN, so edit approval (editApproval.ts) can be decided by content logic
 * instead of read timestamps. Two writers live here:
 *
 * - GrepTool content mode: we generate the rows ourselves, but each shown line
 *   is re-verified against the file before being marked seen (ripgrep elides
 *   lines over --max-columns, so a shown row can differ from disk).
 * - BashTool: a small allowlist of single-file read commands (cat, head, nl,
 *   sed -n 'A,Bp', grep -n) whose output we can map back to exact line ranges
 *   through the security AST. Everything outside the allowlist — pipelines,
 *   redirects, multiple operands, unrecognized flags — records nothing (fail
 *   closed): no sighting just means the model must Read before editing
 *   non-uniquely.
 */

import { parseForSecurity } from './bash/ast.js'
import { normalizeSeenRanges } from './editApproval.js'
import { isENOENT } from './errors.js'
import { expandPath } from './path.js'
import { getFileModificationTime } from './file.js'
import { readFileSyncWithMetadata } from './fileRead.js'
import type { FileStateCache, SeenRange } from './fileStateCache.js'

/** Files larger than this are not snapshotted as sightings (memory bound). */
const SIGHTING_MAX_BYTES = 1024 * 1024

type Snapshot = {
  content: string
  lineArray: string[]
  totalLines: number
  mtimeMs: number
}

function snapshotFile(
  filePath: string,
): { ok: true; snap: Snapshot } | { ok: false } {
  try {
    const meta = readFileSyncWithMetadata(filePath)
    const content = meta.content
    if (Buffer.byteLength(content, 'utf8') > SIGHTING_MAX_BYTES)
      return { ok: false }
    const lineArray = content.split('\n')
    return {
      ok: true,
      snap: {
        content,
        lineArray,
        totalLines: lineArray.length,
        mtimeMs: getFileModificationTime(filePath),
      },
    }
  } catch (e) {
    if (isENOENT(e)) return { ok: false }
    throw e
  }
}

function recordSighting(
  readFileState: FileStateCache,
  filePath: string,
  snap: Snapshot,
  seenRanges: SeenRange[],
  source: 'grep' | 'bash',
): void {
  const ranges = normalizeSeenRanges(seenRanges)
  if (ranges.length === 0) return
  const wholeFile = ranges.length === 1 && ranges[0]!.start <= 1 && ranges[0]!.end >= snap.totalLines
  readFileState.set(filePath, {
    content: snap.content,
    timestamp: Math.floor(snap.mtimeMs),
    offset: undefined,
    limit: undefined,
    seenRanges: wholeFile ? undefined : ranges,
    source,
  })
}

// --- GrepTool content mode ----------------------------------------------------


/**
 * Parse raw ripgrep content-mode output lines into per-file shown rows.
 * Match rows are `path:num:content`, context rows `path-num-content`, and
 * `--` separates groups. Returns nothing for multiline mode (blocks can span
 * lines in ways a per-line map cannot represent).
 */
export function recordGrepContentSightings(
  readFileState: FileStateCache,
  rawLines: string[],
  opts: { multiline: boolean },
): void {
  if (opts.multiline) return
  // path -> (lineNo -> shown text). Later groups overwrite: last-shown wins.
  const byFile = new Map<string, Map<number, string>>()
  for (const line of rawLines) {
    if (line === '--') continue
    // Match rows: `path:num:content`. Context rows: `path-num-content`.
    // The path part is matched lazily so paths containing `-` (or a `C:`
    // drive letter) are not split too early; the digits-plus-separator
    // requirement makes the real boundary win in practice.
    const m =
      line.match(/^(.+?):(\d+):(.*)$/) ?? line.match(/^(.+?)-(\d+)-(.*)$/)
    if (!m) continue
    const filePath = m[1]!
    const lineNo = Number(m[2])
    const shown = m[3]!
    if (!Number.isSafeInteger(lineNo) || lineNo < 1) continue
    let rows = byFile.get(filePath)
    if (!rows) byFile.set(filePath, (rows = new Map()))
    rows.set(lineNo, shown)
  }

  for (const [filePath, rows] of byFile) {
    const snapResult = snapshotFile(filePath)
    if (!snapResult.ok) continue
    const snap = snapResult.snap
    const seen: SeenRange[] = []
    for (const [lineNo, shown] of rows) {
      const actual = snap.lineArray[lineNo - 1]
      if (actual === shown) seen.push({ start: lineNo, end: lineNo })
    }
    recordSighting(readFileState, filePath, snap, seen, 'grep')
  }
}

// --- BashTool read commands ---------------------------------------------------

export type BashSightingCommand = {
  path: string
  /** Lines the command should display, in order, as (1-based) line numbers. */
  expectedLineNos: number[]
  kind: 'contiguous-from' | 'sparse'
}

const HEAD_DEFAULT_LINES = 10

function singleSimpleCommand(
  command: string,
): { argv: string[]; noRedirects: boolean } | null {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1) return null
  const cmd = parsed.commands[0]!
  return { argv: cmd.argv, noRedirects: (cmd.redirects?.length ?? 0) === 0 }
}

/** Classify argv into a line-mappable single-file read, or null (fail closed). */
export function classifyBashReadCommand(
  argv: string[],
  cwd: string,
): BashSightingCommand | null {
  if (argv.length === 0) return null
  const [bin, ...args] = argv
  const fileArg = (p: string): string => expandPath(p, cwd)

  switch (bin) {
    case 'cat':
    case 'nl': {
      if (args.length !== 1 || args[0]!.startsWith('-')) return null
      return {
        path: fileArg(args[0]!),
        expectedLineNos: [],
        kind: 'contiguous-from',
      }
    }
    case 'head': {
      let count = HEAD_DEFAULT_LINES
      let file: string | undefined
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === '-n' && i + 1 < args.length && /^\d+$/.test(args[i + 1]!)) {
          count = Number(args[++i])
        } else if (/^-\d+$/.test(a)) {
          count = Number(a.slice(1))
        } else if (/^-n\d+$/.test(a)) {
          count = Number(a.slice(2))
        } else if (!a.startsWith('-') && file === undefined) {
          file = a
        } else {
          return null
        }
      }
      if (file === undefined) return null
      return {
        path: fileArg(file),
        expectedLineNos: rangeToArray(1, count),
        kind: 'contiguous-from',
      }
    }
    case 'sed': {
      // sed -n '<A>,<B>p' file | sed -n '<N>p' file
      if (args.length !== 3 || args[0] !== '-n') return null
      const spec = args[1]!
      const m = spec.match(/^(\d+)(?:,(\d+))?p$/)
      if (!m) return null
      const start = Number(m[1])
      const end = m[2] !== undefined ? Number(m[2]) : start
      return {
        path: fileArg(args[2]!),
        expectedLineNos: rangeToArray(start, end),
        kind: 'contiguous-from',
      }
    }
    case 'grep': {
      if (!args.includes('-n')) return null
      const flags = new Set(['-n', '-i', '-E', '-F', '-s', '-w', '-x', '-c', '-r', '-l', '-v'])
      const positional: string[] = []
      for (const a of args) {
        if (a.startsWith('-') && flags.has(a)) continue
        if (a.startsWith('-')) return null
        positional.push(a)
      }
      if (positional.length !== 2) return null
      return {
        path: fileArg(positional[1]!),
        expectedLineNos: [],
        kind: 'sparse',
      }
    }
    default:
      return null
  }
}

function rangeToArray(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(i)
  return out
}

// Blank lines are stripped from bash output before the model sees it
// (stripEmptyLines), so expected output is compared with blank lines removed;
// the model still infers their position from the gap, so a matched prefix
// marks a contiguous range.
function shownLinesOf(snap: Snapshot, numbered: boolean): { lineNo: number; text: string }[] {
  const out: { lineNo: number; text: string }[] = []
  snap.lineArray.forEach((line, i) => {
    if (line.trim() === '') return
    const lineNo = i + 1
    out.push({
      lineNo,
      text: numbered ? `${String(lineNo).padStart(6)}\t${line}` : line,
    })
  })
  return out
}

function markBashSighting(
  readFileState: FileStateCache,
  command: string,
  stdout: string,
  cwd: string,
): void {
  const single = singleSimpleCommand(command)
  if (!single || !single.noRedirects) return
  const classified = classifyBashReadCommand(single.argv, cwd)
  if (!classified) return

  const snapResult = snapshotFile(classified.path)
  if (!snapResult.ok) return
  const snap = snapResult.snap

  const shown = stdout.trim()
  if (shown === '') return
  const observed = shown.split('\n')

  if (classified.kind === 'sparse') {
    // grep -n: every output line must be `num:content` and agree with disk,
    // or we know nothing about what the model actually saw.
    const seen: SeenRange[] = []
    for (const line of observed) {
      const m = line.match(/^(\d+):(.*)$/)
      if (!m) return
      const lineNo = Number(m[1])
      if (snap.lineArray[lineNo - 1] !== m[2]) return
      seen.push({ start: lineNo, end: lineNo })
    }
    recordSighting(readFileState, classified.path, snap, seen, 'bash')
    return
  }

  // Contiguous readers: compare the longest matching prefix of expected
  // output. `cat`/`nl` display the whole file; `head`/`sed -n` a window.
  const numbered = single.argv[0] === 'nl'
  let expected = shownLinesOf(snap, numbered)
  if (classified.expectedLineNos.length > 0) {
    const want = new Set(classified.expectedLineNos)
    expected = expected.filter(e => want.has(e.lineNo))
  }
  let matched = 0
  while (
    matched < observed.length &&
    matched < expected.length &&
    observed[matched] === expected[matched]!.text
  ) {
    matched++
  }
  if (matched === 0) return
  const lastLine = expected[matched - 1]!.lineNo
  // Prefix match — whether or not the output was cut, the model saw lines
  // start..lastLine (blank lines were stripped from the output but remain
  // inferable from their gaps, so the range is contiguous).
  const start = expected[0]!.lineNo
  recordSighting(readFileState, classified.path, snap, [{ start, end: lastLine }], 'bash')
}

/**
 * Record a sighting for a successfully-run bash command whose stdout we are
 * about to show the model. Unrecognized / partially-truncated forms record
 * nothing.
 */
export function recordBashReadSighting(
  readFileState: FileStateCache,
  command: string,
  stdout: string,
  cwd: string,
): void {
  try {
    markBashSighting(readFileState, command, stdout, cwd)
  } catch {
    // Sightings are an optimization: any failure just means the next edit on
    // this file needs a Read.
  }
}
