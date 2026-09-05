import { normalize } from 'path'
import type { FileState, FileStateCache } from './fileStateCache.js'

/**
 * One splice applied to a file, in the coordinate space of the document as it
 * stood immediately before this splice. For an insertion after line N,
 * oldStart is N + 1 and oldLen is 0; for a top-of-file insertion, oldStart is 1.
 */
export type AppliedPatch = {
  oldStart: number
  oldLen: number
  newLen: number
}

// Per response, per file. Overflow invalidates remapping until a Read restores
// it, rather than folding patches across coordinate spaces.
export const MAX_RESPONSE_EDIT_PATCHES = 64

export const PATCH_CAP_INVALIDATION =
  'Too many earlier edits in this response to remap anchors safely. Re-read the file before editing it again.'

export type ResponseFileEditState = {
  /** Read/Edit/Write entry at the point this response began tracking the file. */
  snapshot: FileState | undefined
  /**
   * The full file content the model's anchors were minted against, once it is
   * known (a full Read entry, or disk content verified against the snapshot).
   */
  baselineContent: string | undefined
  /** Content expected on disk after this response's own successful edits. */
  expectedCurrentContent: string | undefined
  /** Successful edits this response, in chronological splice order. */
  patches: AppliedPatch[]
  /** Set when remapping is unsafe; forces a re-Read before the next edit. */
  remapUnavailableReason: string | undefined
}

// A Read from line 1 with no limit covers the whole file (Read always
// records an explicit offset), so its content can seed the baseline.
function isFullFileSnapshot(entry: FileState): boolean {
  return (
    (entry.offset === undefined || entry.offset <= 1) &&
    entry.limit === undefined &&
    !entry.isPartialView
  )
}

/**
 * Response-local Edit bookkeeping. One instance per assistant response (one
 * query-loop iteration), shared by every tool call in that response via
 * ToolUseContext. Lets a later Edit call in the same message resolve anchors
 * from the snapshot the model actually saw: the model wrote every call before
 * seeing any result, so only the harness knows which earlier patches shifted
 * which lines. Not conversation state — the next response starts from the
 * post-edit files and intentionally rejects anchors that a structural edit
 * moved.
 */
export class ResponseEditState {
  private files = new Map<string, ResponseFileEditState>()

  /**
   * Freezes the Read/Write state at the start of a model response. Full Read
   * entries already hold the shown content, so they seed the baseline directly;
   * partial or partial-view entries start unmaterialized and get their baseline
   * from disk once Edit's staleness checks have passed.
   */
  static fromReadFileState(cache: FileStateCache): ResponseEditState {
    const state = new ResponseEditState()
    for (const [path, entry] of cache.entries()) {
      const isFullSnapshot = isFullFileSnapshot(entry)
      state.files.set(normalize(path), {
        snapshot: { ...entry },
        baselineContent: isFullSnapshot ? entry.content : undefined,
        expectedCurrentContent: isFullSnapshot ? entry.content : undefined,
        patches: [],
        remapUnavailableReason: undefined,
      })
    }
    return state
  }

  get(filePath: string): ResponseFileEditState | undefined {
    return this.files.get(normalize(filePath))
  }

  /**
   * Records the verified pre-edit content for a file with no seeded baseline.
   * The caller must have established (mtime/content checks) that `content`
   * still corresponds to what the model was shown.
   */
  beginBaseline(
    filePath: string,
    content: string,
    snapshot?: FileState,
  ): ResponseFileEditState {
    const key = normalize(filePath)
    const entry = this.files.get(key) ?? {
      snapshot,
      baselineContent: undefined,
      expectedCurrentContent: undefined,
      patches: [],
      remapUnavailableReason: undefined,
    }
    if (entry.baselineContent === undefined) {
      entry.baselineContent = content
    }
    if (entry.expectedCurrentContent === undefined) {
      entry.expectedCurrentContent = content
    }
    if (snapshot && !entry.snapshot) {
      entry.snapshot = snapshot
    }
    this.files.set(key, entry)
    return entry
  }

  /**
   * Appends the splices one successful Edit actually applied. Failed, denied,
   * or superseded edits must record nothing.
   */
  recordEdit(
    filePath: string,
    afterContent: string,
    patches: readonly AppliedPatch[],
  ): void {
    const key = normalize(filePath)
    const entry = this.files.get(key)
    if (!entry || entry.remapUnavailableReason) {
      return
    }
    entry.expectedCurrentContent = afterContent
    entry.patches.push(...patches)
    if (entry.patches.length > MAX_RESPONSE_EDIT_PATCHES) {
      entry.patches = []
      entry.baselineContent = undefined
      entry.remapUnavailableReason = PATCH_CAP_INVALIDATION
    }
  }

  /**
   * A Read, Write, or amended edit established new ground truth: the model
   * now has (or authored) this content, so remapping restarts from it.
   */
  replaceSnapshot(filePath: string, snapshot: FileState): void {
    const isFullSnapshot = isFullFileSnapshot(snapshot)
    this.files.set(normalize(filePath), {
      snapshot: { ...snapshot },
      baselineContent: isFullSnapshot ? snapshot.content : undefined,
      expectedCurrentContent: isFullSnapshot ? snapshot.content : undefined,
      patches: [],
      remapUnavailableReason: undefined,
    })
  }

  /**
   * The file moved under the response (external mutation, or bookkeeping
   * overflow). Held anchors are untrustworthy until a Read runs.
   */
  invalidate(filePath: string, reason: string): void {
    const key = normalize(filePath)
    const entry = this.files.get(key)
    if (!entry) {
      return
    }
    entry.patches = []
    entry.baselineContent = undefined
    entry.remapUnavailableReason = reason
  }
}
