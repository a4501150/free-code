/**
 * Placement notes for Edit/Write, decided by content logic rather than
 * timestamps: an entry in the read-state ledger proves the model was SHOWN
 * specific lines of a specific file state (Read rows, Grep content rows, a
 * recognized Bash read command, or the content its own Edit/Write authored).
 *
 * Edit itself has no seen-ledger gate: an edit applies whenever it verifies
 * against current disk content, and the note only tells the model how much
 * of the file's current state its context can vouch for. Write keeps a real
 * gate — overwriting the UNSEEN rest of a file is a different risk — so
 * approveWrite still rejects on a missing/partial sighting.
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
  /** Disk changed since the sighting and the edited text is not inside the
   *  seen lines, but the match against current disk is unique — the same
   *  proof a blind placement gets. */
  | 'blind-modified'
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
 * Classify how much of `plan`'s placement the model's seen state can vouch
 * for, given the plan (computed against current disk content). Never gates:
 * the plan already verified against current disk, so this only picks the
 * note that rides the result message.
 */
export function editPlacementNote(args: {
  state: FileState | undefined
  currentContent: string
  plan: EditPlan
}): ApprovalNote {
  const { state, currentContent, plan } = args

  // No usable claim about the bytes. Unverified states (resume rebuilds)
  // count as no claim — their content text may differ from what was shown.
  if (!state || state.isPartialView || isUnverifiedState(state)) {
    return 'blind'
  }

  if (state.content === currentContent) {
    return spansSeen(state, plan.spans) ? 'fresh' : 'blind-placement'
  }

  // Disk changed since the sighting; the grounded-in-seen-lines case
  // upgrades the note.
  const seenSpan = findSeenSpan(state, plan.searchText)
  return seenSpan &&
    seenCoversLines(state, seenSpan.startLine, seenSpan.endLine)
    ? 'recovered'
    : 'blind-modified'
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
