/**
 * Content sightings: records which lines of which files the model was actually
 * SHOWN, so edit approval (editApproval.ts) can be decided by content logic
 * instead of read timestamps. One writer:
 *
 * - BashTool: a small allowlist of single-file read commands (cat, head, nl,
 *   sed -n 'A,Bp', grep -n, rg -n) whose output we can map back to exact line
 *   ranges through the security AST, chained with `;`/`&&` (and constant
 *   `echo` separators) as long as every stage is recognized: the stages' own
 *   outputs verify against disk in stream order, so each records its sighting
 *   where it matched. Everything outside the allowlist — pipeline stages that
 *   consume stdin, redirects, multiple operands, unrecognized flags — records
 *   nothing for the whole command (fail closed): no sighting just means the
 *   model must Read before editing non-uniquely.
 */

import { parseForSecurity } from './bash/ast.js'
import { normalizeSeenRanges } from './editApproval.js'
import { isENOENT } from './errors.js'
import { expandPath } from './path.js'
import { getFileModificationTime } from './file.js'
import { readFileSyncWithMetadata, stripBom } from './fileRead.js'
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
    // Ledger contents are BOM-free everywhere; the Read path shows BOM-free
    // text too, so sightings must not resurrect the BOM.
    const content = stripBom(meta.content)
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
  source: 'bash',
): void {
  const ranges = normalizeSeenRanges(seenRanges)
  if (ranges.length === 0) return
  const wholeFile =
    ranges.length === 1 &&
    ranges[0]!.start <= 1 &&
    ranges[0]!.end >= snap.totalLines
  // Merge with an existing sighting instead of overwriting it: one rg after
  // a whole-file Read must not narrow what the model saw down to the matched
  // lines. Both claims refer to the same bytes only when the snapshots are
  // identical, so the seen ranges (always file-absolute) are unioned exactly
  // in that case; a changed file falls back to this sighting alone.
  const prev = readFileState.get(filePath)
  if (
    prev &&
    !prev.isPartialView &&
    prev.content === snap.content &&
    (prev.contentFirstLine === undefined || prev.contentFirstLine === 1)
  ) {
    readFileState.set(filePath, {
      ...prev,
      seenRanges:
        prev.seenRanges === undefined
          ? undefined
          : normalizeSeenRanges([...prev.seenRanges, ...ranges]),
      source: prev.source ?? source,
    })
    return
  }
  readFileState.set(filePath, {
    content: snap.content,
    timestamp: Math.floor(snap.mtimeMs),
    offset: undefined,
    limit: undefined,
    seenRanges: wholeFile ? undefined : ranges,
    source,
  })
}

// --- BashTool read commands ---------------------------------------------------

export type BashSightingCommand = {
  path: string
  /** Lines the command should display, in order, as (1-based) line numbers. */
  expectedLineNos: number[]
  kind: 'contiguous-from' | 'sparse'
  /** Rows carry nl-style `num\t` prefixes (affects expected-output compare). */
  numbered: boolean
}

const HEAD_DEFAULT_LINES = 10

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
        numbered: bin === 'nl',
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
        numbered: false,
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
        numbered: false,
      }
    }
    case 'rg': {
      // ripgrep shows matched lines only; with -n every row is
      // `num:content` (a directory operand adds a file prefix that the
      // sparse verifier rejects, so that fails closed too). Only
      // single-char flags, bundled ones included; context, replace and
      // glob flags alter the rows and stay out of the allowlist.
      const LETTERS = new Set('niFwxv')
      const positional: string[] = []
      let sawLineNo = false
      for (const a of args) {
        if (a.startsWith('-')) {
          const letters = a.slice(1)
          if (
            letters.length === 0 ||
            !letters.split('').every(c => LETTERS.has(c))
          )
            return null
          sawLineNo ||= letters.includes('n')
        } else {
          positional.push(a)
        }
      }
      if (!sawLineNo || positional.length !== 2) return null
      return {
        path: fileArg(positional[1]!),
        expectedLineNos: [],
        kind: 'sparse',
        numbered: false,
      }
    }
    case 'grep': {
      if (!args.includes('-n')) return null
      const flags = new Set([
        '-n',
        '-i',
        '-E',
        '-F',
        '-s',
        '-w',
        '-x',
        '-c',
        '-r',
        '-l',
        '-v',
      ])
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
        numbered: false,
      }
    }
    default:
      return null
  }
}

/**
 * One stage of a `;`/`&&`-chained read view: a classified read command, or an
 * `echo` with literal args (a constant separator row the verifier skips).
 * Every classification requires a file operand, so a pipeline stage reading
 * stdin (head, tail, a second grep) is never classified and the whole command
 * stays out of the ledger.
 */
type ChainStep =
  | { kind: 'echo'; line: string }
  | { kind: 'read'; cmd: BashSightingCommand }

function classifyChainStep(argv: string[], cwd: string): ChainStep | null {
  if (argv[0] === 'echo') {
    const args = argv.slice(1)
    // -n/-e change the emitted bytes; a run of bare dashes is printed
    // literally by both BSD and GNU echo.
    for (const a of args) {
      if (a.startsWith('-') && !/^[-+]+$/.test(a)) return null
    }
    return { kind: 'echo', line: args.join(' ') }
  }
  const cmd = classifyBashReadCommand(argv, cwd)
  return cmd ? { kind: 'read', cmd } : null
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
function shownLinesOf(
  snap: Snapshot,
  numbered: boolean,
): { lineNo: number; text: string }[] {
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

/**
 * Verify one chain stage's output at `start` in the observed stream and
 * record what it proves. Returns the rows consumed and whether the chain
 * stops here: a contiguous stage whose expected output ended early means the
 * capture cut the stream — later stages produced nothing the model saw. A
 * sparse stage never stops the chain; its unverified tail is handed to the
 * next stage (or ends the walk at the last stage, where it voids that stage
 * but not the earlier sightings).
 */
function verifyReadStep(
  readFileState: FileStateCache,
  cmd: BashSightingCommand,
  snap: Snapshot,
  observed: string[],
  start: number,
  hasNextStep: boolean,
): { consumed: number; stop: boolean } {
  if (cmd.kind === 'sparse') {
    // grep -n: rows must be `num:content` and agree with disk, or we know
    // nothing about what the model actually saw. A non-verifying row ends
    // the stage's output; mid-chain it may be the next stage's first row,
    // so the verified prefix is still recorded. As the last stage, one bad
    // row voids the stage: it may be a display-width cut, and trusting a
    // prefix of unverifiable output is exactly what fails open.
    const seen: SeenRange[] = []
    let i = start
    for (; i < observed.length; i++) {
      const m = observed[i]!.match(/^(\d+):(.*)$/)
      if (!m) break
      const lineNo = Number(m[1])
      if (snap.lineArray[lineNo - 1] !== m[2]) break
      seen.push({ start: lineNo, end: lineNo })
    }
    const aborted = i < observed.length
    if (seen.length === 0 || (aborted && !hasNextStep)) {
      return { consumed: 0, stop: false }
    }
    recordSighting(readFileState, cmd.path, snap, seen, 'bash')
    return { consumed: i - start, stop: false }
  }

  // Contiguous readers: compare the longest matching prefix of expected
  // output. `cat`/`nl` display the whole file; `head`/`sed -n` a window.
  let expected = shownLinesOf(snap, cmd.numbered)
  if (cmd.expectedLineNos.length > 0) {
    const want = new Set(cmd.expectedLineNos)
    expected = expected.filter(e => want.has(e.lineNo))
  }
  let matched = 0
  while (
    start + matched < observed.length &&
    matched < expected.length &&
    observed[start + matched] === expected[matched]!.text
  ) {
    matched++
  }
  if (matched === 0) return { consumed: 0, stop: false }
  const lastLine = expected[matched - 1]!.lineNo
  // Prefix match — whether or not the output was cut, the model saw lines
  // start..lastLine (blank lines were stripped from the output but remain
  // inferable from their gaps, so the range is contiguous).
  const startLine = expected[0]!.lineNo
  recordSighting(
    readFileState,
    cmd.path,
    snap,
    [{ start: startLine, end: lastLine }],
    'bash',
  )
  return { consumed: matched, stop: matched < expected.length }
}

function markBashSighting(
  readFileState: FileStateCache,
  command: string,
  stdout: string,
  cwd: string,
): void {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple' || parsed.commands.length === 0) return
  const steps: ChainStep[] = []
  for (const cmd of parsed.commands) {
    if ((cmd.redirects?.length ?? 0) > 0) return
    const step = classifyChainStep(cmd.argv, cwd)
    if (!step) return
    steps.push(step)
  }

  const shown = stdout.trim()
  if (shown === '') return
  const observed = shown.split('\n')

  // Stages execute in order, so their outputs are concatenated in the
  // stream; walk it with a cursor. Recorded claims are verified against
  // disk wherever they matched, so a stage that consumed rows belonging to
  // a later stage (identical text) still records a true sighting.
  let cursor = 0
  for (let i = 0; i < steps.length; i++) {
    if (cursor >= observed.length) break
    const hasNextStep = i < steps.length - 1
    const step = steps[i]!
    if (step.kind === 'echo') {
      // An argument-less echo prints a blank line, which the harness strips
      // from the model's view — it consumes nothing.
      if (step.line === '') continue
      if (observed[cursor] !== step.line) return
      cursor++
      continue
    }
    const snapResult = snapshotFile(step.cmd.path)
    if (!snapResult.ok) return
    const r = verifyReadStep(
      readFileState,
      step.cmd,
      snapResult.snap,
      observed,
      cursor,
      hasNextStep,
    )
    // A stage that matched nothing may legitimately have printed nothing
    // (no grep hits, a window past EOF): give the next stage its chance at
    // the same rows. A stage that ended early means the capture cut here.
    cursor += r.consumed
    if (r.stop) break
  }
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
