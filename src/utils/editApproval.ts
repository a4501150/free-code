/**
 * Placement approval for Edit/Write, decided by content logic rather than
 * timestamps: an entry in the read-state ledger proves the model was SHOWN
 * specific lines of a specific file state (Read rows, Grep content rows, a
 * recognized Bash read command, or the content its own Edit/Write authored).
 *
 * An edit is approved when it verifies against current disk content AND its
 * placement is grounded in what the model saw. Timestamps are only ever a
 * cheap re-validation hint — `touch` with unchanged content approves, and a
 * formatter rewrite can still approve when the edited text is inside the seen
 * region and unchanged there.
 */

import type { EditPlan, MatchSpan } from './editMatch.js'
import {
  buildLineOffsets,
  lineForOffset,
  normalizeCurlyQuotes,
} from './editMatch.js'
import type { FileState, SeenRange } from './fileStateCache.js'

export type ApprovalNote =
  /** The model's view of the file is current and it saw the edited lines. */
  | 'fresh'
  /** Disk changed since the sighting; the exact text was seen at the seen
   *  lines and still matches uniquely on disk. */
  | 'recovered'
  /** File content is current but the edited lines fall outside the ranges
   *  actually shown (e.g. only the top of the file was Read). */
  | 'blind-placement'
  /** No sighting at all; the unique match against disk is the whole proof. */
  | 'blind'

export type ApprovalResult =
  | { ok: true; note: ApprovalNote }
  | { ok: false; message: string; errorCode: number }

export const FILE_NOT_READ_YET_MESSAGE =
  'File has not been read yet. Read it first before writing to it.'
export const FILE_MODIFIED_SINCE_READ_MESSAGE =
  'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'
export const FILE_PARTIALLY_READ_MESSAGE =
  'File has only been partially read so far. Use the Read tool on the whole file (no offset/limit) before writing to it.'
export const FILE_STALE_VIEW_MESSAGE =
  'The recorded view of this file was rebuilt from an earlier session and cannot be verified against its current bytes. Read it again with the Read tool before writing to it.'

/** True when the entry's content may differ from the exact bytes shown. */
export function isUnverifiedState(state: FileState | undefined): boolean {
  return state !== undefined && state.contentVerified === false
}

/** True when every line in [startLine, endLine] is inside one seen range. */
export function seenCoversLines(
  state: FileState,
  startLine: number,
  endLine: number,
): boolean {
  if (state.isPartialView) return false
  if (state.seenRanges === undefined) return true
  return state.seenRanges.some(r => r.start <= startLine && r.end >= endLine)
}

function spansSeen(state: FileState, spans: MatchSpan[]): boolean {
  return spans.every(s => seenCoversLines(state, s.startLine, s.endLine))
}

/**
 * Locate searchText inside the content the model was shown. Returns the span
 * only when it occurs exactly once — an ambiguous sighting says nothing about
 * which copy the model means.
 */
function findSeenSpan(state: FileState, searchText: string): MatchSpan | null {
  const haystack = normalizeCurlyQuotes(state.content)
  const needle = normalizeCurlyQuotes(searchText)
  const first = haystack.indexOf(needle)
  if (first === -1) return null
  if (haystack.indexOf(needle, first + needle.length) !== -1) return null
  const lineOffsets = buildLineOffsets(state.content)
  // Slice entries (files too large for a whole-file snapshot) index from
  // contentFirstLine, not from file line 1.
  const base = (state.contentFirstLine ?? 1) - 1
  return {
    offset: first,
    length: needle.length,
    startLine: base + lineForOffset(lineOffsets, first),
    endLine: base + lineForOffset(lineOffsets, first + needle.length - 1),
  }
}

/**
 * Approve applying `plan` (computed against current disk content) given the
 * model's seen state for the file. `plan.spans` must already be disambiguated
 * (one span, or every span for replace_all).
 */
export function approveEdit(args: {
  state: FileState | undefined
  currentContent: string
  plan: EditPlan
}): ApprovalResult {
  const { state, currentContent, plan } = args

  // No usable claim about the bytes: blind unique-match placement only.
  // Unverified entries (resume rebuilds) count as no claim — their content
  // text may differ from what was shown, so neither the fresh check nor the
  // recovery path can trust it.
  if (!state || state.isPartialView || isUnverifiedState(state)) {
    if (plan.spans.length === 1) return { ok: true, note: 'blind' }
    return {
      ok: false,
      message: isUnverifiedState(state)
        ? FILE_STALE_VIEW_MESSAGE
        : FILE_NOT_READ_YET_MESSAGE,
      errorCode: 6,
    }
  }

  if (state.content === currentContent) {
    return spansSeen(state, plan.spans)
      ? { ok: true, note: 'fresh' }
      : { ok: true, note: 'blind-placement' }
  }

  // Disk changed since the sighting. Recovery requires: a single placement
  // (replace_all over a file whose current state the model cannot picture
  // needs a re-Read), the exact text present once inside the seen lines (the
  // model is pointing at content it actually looked at), and the current-disk
  // match already unique (spans.length === 1).
  if (plan.spans.length !== 1) {
    return {
      ok: false,
      message: FILE_MODIFIED_SINCE_READ_MESSAGE,
      errorCode: 7,
    }
  }
  const seenSpan = findSeenSpan(state, plan.searchText)
  if (
    !seenSpan ||
    !seenCoversLines(state, seenSpan.startLine, seenSpan.endLine)
  ) {
    return {
      ok: false,
      message: FILE_MODIFIED_SINCE_READ_MESSAGE,
      errorCode: 7,
    }
  }
  return { ok: true, note: 'recovered' }
}

/** True when the entry proves the model saw the entire current file content. */
export function wholeFileSeen(
  state: FileState | undefined,
  currentContent: string,
): boolean {
  if (!state || state.isPartialView || isUnverifiedState(state)) return false
  // Slice entries only ever claim the shown window, never the whole file.
  if (state.contentFirstLine !== undefined && state.contentFirstLine !== 1)
    return false
  if (state.content !== currentContent) return false
  if (state.seenRanges === undefined) return true
  const totalLines = buildLineOffsets(currentContent).length
  return seenCoversLines(state, 1, totalLines)
}

/**
 * Approve a Write (full overwrite) of an existing file: the model must have
 * seen the WHOLE file in its current state — a grep snippet or a head-full of
 * lines does not license replacing everything else unseen.
 */
export function approveWrite(args: {
  state: FileState | undefined
  fileExists: boolean
  currentContent: string
}): ApprovalResult {
  const { state, fileExists, currentContent } = args
  if (!fileExists) return { ok: true, note: 'fresh' }
  if (wholeFileSeen(state, currentContent)) return { ok: true, note: 'fresh' }
  if (isUnverifiedState(state)) {
    return { ok: false, message: FILE_STALE_VIEW_MESSAGE, errorCode: 4 }
  }
  if (state && !state.isPartialView) {
    // A whole-file sighting of content that is no longer on disk (the model
    // saw the complete file; a linter or the user moved it afterwards). A
    // whole claim is only an omitted seenRanges on verified content — a
    // ranged Read captured a window, and covering every line of that window
    // proves nothing about the rest of the file.
    const wholeSighting =
      state.seenRanges === undefined &&
      (state.contentFirstLine === undefined || state.contentFirstLine === 1)
    if (wholeSighting) {
      return {
        ok: false,
        message: FILE_MODIFIED_SINCE_READ_MESSAGE,
        errorCode: 3,
      }
    }
    return { ok: false, message: FILE_PARTIALLY_READ_MESSAGE, errorCode: 2 }
  }
  return { ok: false, message: FILE_NOT_READ_YET_MESSAGE, errorCode: 2 }
}

/** Helper for sighting writers: clamp a range to the file and normalize. */
export function clampSeenRange(
  range: SeenRange,
  totalLines: number,
): SeenRange | null {
  const start = Math.max(1, Math.floor(range.start))
  const end = Math.min(totalLines, Math.floor(range.end))
  return end >= start ? { start, end } : null
}

/** Merge overlapping/adjacent ranges and sort by start. */
export function normalizeSeenRanges(ranges: SeenRange[]): SeenRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: SeenRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}
