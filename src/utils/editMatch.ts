/**
 * Content-matching engine for the Edit tool's (old_string → new_string)
 * replacement. Matches against the LF-normalized file text and enumerates
 * every occurrence so the caller can enforce single-match placement (by
 * content alone — there are no line-range parameters; ambiguity is resolved
 * by extending old_string's context) or apply replace_all.
 *
 * Failed exact matches get failure-driven repair retries, in order:
 * curly-quote normalization (length-preserving, so match offsets transfer to
 * the original text), \uXXXX-escape ↔ character normalization, line
 * prefix repair (the model pasted Read/Grep rows — every old_string line
 * starts with `N:` / `N→` / `N\t` / legacy `N:hash|` — with ascending line
 * numbers), and a whole-line whitespace-tolerant pass for multi-line
 * old_string (per-line trim comparison, mirroring codex's seek_sequence
 * ladder, absorbing copied-with-drifted-indentation or trailing-whitespace).
 * Repairs transform new_string too, so the written text matches the file's
 * encoding of quotes/escapes and doesn't carry line-number garbage.
 */

export type MatchSpan = {
  /** Index into the LF-normalized file text. */
  offset: number
  length: number
  /** 1-based line of the span's first character. */
  startLine: number
  /** 1-based line of the span's last character. */
  endLine: number
}

export type MatchStrategy =
  | 'exact'
  | 'quotes'
  | 'escapes'
  | 'line-prefix'
  | 'whitespace'

export type EditPlanRequest = {
  oldString: string
  newString: string
  replaceAll: boolean
}

export type EditPlan = {
  updatedContent: string
  /** The (possibly repaired) text that was matched, for seen-content checks. */
  searchText: string
  strategy: MatchStrategy
  /** Spans that were replaced, ascending. */
  spans: MatchSpan[]
}

export type EditPlanFailure = {
  message: string
  errorCode: number
}

export type EditPlanResult =
  | { ok: true; plan: EditPlan }
  | { ok: false; failure: EditPlanFailure }

// --- Line helpers -----------------------------------------------------------

/** Byte offsets of each line start; index 0 = line 1. */
export function buildLineOffsets(text: string): number[] {
  const offsets = [0]
  let i = text.indexOf('\n')
  while (i !== -1) {
    offsets.push(i + 1)
    i = text.indexOf('\n', i + 1)
  }
  return offsets
}

export function lineForOffset(lineOffsets: number[], offset: number): number {
  let lo = 0
  let hi = lineOffsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineOffsets[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// --- Quote normalization ----------------------------------------------------

const CURLY_MAP: Record<string, string> = {
  '\u2018': "'", // left single
  '\u2019': "'", // right single / apostrophe
  '\u201C': '"', // left double
  '\u201D': '"', // right double
}

export function containsCurlyQuotes(s: string): boolean {
  return /[\u2018\u2019\u201C\u201D]/.test(s)
}

/** Curly → straight quotes. Length-preserving, so offsets transfer 1:1. */
export function normalizeCurlyQuotes(s: string): string {
  return s.replace(/[\u2018\u2019\u201C\u201D]/g, ch => CURLY_MAP[ch]!)
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/**
 * Re-apply typographic quotes to plain text, for writing new_string back into
 * a file whose matched region used curly quotes. Heuristic (like the official
 * tool): a straight `"` opens after start/whitespace/open punctuation and
 * closes otherwise; `'` between word characters is an apostrophe (right
 * single), otherwise opens/closes like `"`.
 */
export function restoreCurlyQuotes(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch !== '"' && ch !== "'") {
      out += ch
      continue
    }
    const prev = i > 0 ? s[i - 1]! : ''
    const next = i < s.length - 1 ? s[i + 1]! : ''
    const prevWord = WORD_CHAR.test(prev)
    const nextWord = WORD_CHAR.test(next)
    if (ch === "'") {
      out += prevWord && nextWord ? '\u2019' : prevWord ? '\u2019' : '\u2018'
    } else {
      out += prev === '' || /[\s([{]/.test(prev) ? '\u201C' : '\u201D'
    }
  }
  return out
}

// --- \uXXXX escape normalization ---------------------------------------------

const ESCAPE_RE = /\\u([0-9a-fA-F]{4})/
const ESCAPE_RE_GLOBAL = /\\u([0-9a-fA-F]{4})/g

export function containsUnicodeEscapes(s: string): boolean {
  return ESCAPE_RE.test(s)
}

function unescapeUnicode(s: string): string {
  return s.replace(ESCAPE_RE_GLOBAL, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

function escapeNonAscii(s: string, upperHex: boolean): string {
  return s.replace(/[^\x00-\x7F]/g, ch => {
    const hex = ch.charCodeAt(0).toString(16)
    const padded = hex.padStart(4, '0')
    return '\\u' + (upperHex ? padded.toUpperCase() : padded)
  })
}

// --- Line-prefix repair -------------------------------------------------------

// Matches a model-pasted Read/Grep row prefix: `N:` optionally followed by a
// legacy hashline hash and `|`, or the `N→` / `N\t` forms from older formats.
const LINE_ROW_PREFIX = /^\s*(\d+)(?::(?:[0-9a-z]{3,8}\|)?|[→\t])(.*)$/

/**
 * If every line of `text` looks like a Read/Grep row and the line numbers are
 * strictly consecutive ascending, strip the prefixes and return the cleaned
 * text. Single-line input skips the ascending check (no sequence to verify).
 */
export function stripLineRowPrefixes(text: string): string | null {
  const lines = text.split('\n')
  const stripped: string[] = []
  let first = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(LINE_ROW_PREFIX)
    if (!m) return null
    const num = Number(m[1])
    if (!Number.isSafeInteger(num)) return null
    if (i === 0) first = num
    else if (num !== first + i) return null
    stripped.push(m[2]!)
  }
  return stripped.join('\n')
}

/** Strip row prefixes from new_string lines that individually look like rows. */
function stripNewStringPrefixes(text: string): string {
  if (text === '') return text
  return text
    .split('\n')
    .map(line => {
      const m = line.match(LINE_ROW_PREFIX)
      return m ? m[2]! : line
    })
    .join('\n')
}

// --- Search resolution --------------------------------------------------------

type ResolvedSearch = {
  /** Text to search for. Under 'quotes' this is searched against the
   *  quote-normalized file (offsets transfer because normalization is 1:1). */
  searchText: string
  strategy: MatchStrategy
  /** Transform to apply to new_string so the written text fits the file. */
  transformNew: (newString: string) => string
}

function resolveSearch(
  fileText: string,
  oldString: string,
): ResolvedSearch | null {
  if (fileText.includes(oldString)) {
    return { searchText: oldString, strategy: 'exact', transformNew: n => n }
  }

  if (containsCurlyQuotes(oldString)) {
    const normOld = normalizeCurlyQuotes(oldString)
    if (normalizeCurlyQuotes(fileText).includes(normOld)) {
      return {
        searchText: normOld,
        strategy: 'quotes',
        transformNew: restoreCurlyQuotes,
      }
    }
  }

  if (containsUnicodeEscapes(oldString)) {
    // The model quoted \uXXXX escapes; the file holds the raw characters.
    const unescaped = unescapeUnicode(oldString)
    if (fileText.includes(unescaped)) {
      return {
        searchText: unescaped,
        strategy: 'escapes',
        transformNew: unescapeUnicode,
      }
    }
  }

  if (/[^\x00-\x7F]/.test(oldString)) {
    // The other direction: the file stores \uXXXX escape text and the model
    // quoted the raw character. Hex case follows the file's first escape.
    const firstHex = fileText.match(ESCAPE_RE)?.[1] ?? ''
    const upperHex = /[A-F]/.test(firstHex)
    const escaped = escapeNonAscii(oldString, upperHex)
    if (escaped !== oldString && fileText.includes(escaped)) {
      return {
        searchText: escaped,
        strategy: 'escapes',
        transformNew: n => escapeNonAscii(n, upperHex),
      }
    }
  }

  if (oldString.length > 0) {
    const repaired = stripLineRowPrefixes(oldString)
    if (repaired !== null && repaired !== '' && fileText.includes(repaired)) {
      return {
        searchText: repaired,
        strategy: 'line-prefix',
        transformNew: stripNewStringPrefixes,
      }
    }
  }

  return null
}

// --- Span enumeration ---------------------------------------------------------

function findAllOffsets(haystack: string, needle: string): number[] {
  const offsets: number[] = []
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    offsets.push(idx)
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return offsets
}

function spansFromOffsets(
  searchText: string,
  offsets: number[],
  lineOffsets: number[],
): MatchSpan[] {
  return offsets.map(offset => ({
    offset,
    length: searchText.length,
    startLine: lineForOffset(lineOffsets, offset),
    endLine: lineForOffset(lineOffsets, offset + searchText.length - 1),
  }))
}

// --- Whitespace-tolerant whole-line matching --------------------------------

/**
 * Whole-line, whitespace-tolerant pass for multi-line old_string: matches
 * when each old_string line equals a consecutive run of file lines under
 * trim(). Spans cover the WHOLE file lines (indentation and trailing
 * whitespace included), so a drifted copy still replaces exactly the lines
 * the model meant. Single-line old_string never uses this pass — a trimmed
 * substring match would clobber unrelated surrounding text on the line.
 * Returns non-overlapping spans ascending, or null when not applicable.
 */
function findWhitespaceSpans(
  fileText: string,
  oldString: string,
  lineOffsets: number[],
): MatchSpan[] | null {
  const want = oldString.split('\n')
  if (want.length < 2) return null
  const wantTrim = want.map(l => l.trim())
  const fileLines = fileText.split('\n')
  const spans: MatchSpan[] = []
  let i = 0
  while (i + want.length <= fileLines.length) {
    let ok = true
    for (let j = 0; j < want.length; j++) {
      if (fileLines[i + j]!.trim() !== wantTrim[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      const offset = lineOffsets[i]!
      const end =
        i + want.length < fileLines.length
          ? lineOffsets[i + want.length]! - 1
          : fileText.length
      spans.push({
        offset,
        length: end - offset,
        startLine: i + 1,
        endLine: i + want.length,
      })
      i += want.length
    } else {
      i++
    }
  }
  return spans.length > 0 ? spans : null
}

// --- Plan ---------------------------------------------------------------------

function matchLineList(spans: MatchSpan[]): string {
  return spans.map(s => String(s.startLine)).join(', ')
}

/**
 * Resolve one Edit request against the current (LF-normalized) file content:
 * repair retries, all-match enumeration, content-only disambiguation,
 * the delete-trailing-newline heuristic, and application. Pure — no I/O, no
 * state. Placement approval against the seen ledger is a separate step
 * (editApproval.ts); this only guarantees the replacement is well-defined
 * against the given text.
 */
export function planEdit(
  fileText: string,
  req: EditPlanRequest,
): EditPlanResult {
  const { oldString, newString, replaceAll } = req

  const lineOffsets = buildLineOffsets(fileText)
  const notFound = (): EditPlanResult => {
    let message = `String to replace not found in file.\nString: ${oldString}`
    if (
      containsUnicodeEscapes(oldString) ||
      containsCurlyQuotes(oldString) ||
      /[^\x00-\x7F]/.test(oldString)
    ) {
      message +=
        ' (note: the tool also tried swapping unicode escapes and their characters, and curly and straight quotes; neither form matched, so the mismatch is likely elsewhere in old_string. Re-read the file and copy the exact surrounding text.)'
    }
    return { ok: false, failure: { message, errorCode: 8 } }
  }

  const resolved = resolveSearch(fileText, oldString)
  let spans: MatchSpan[]
  let searchText: string
  let strategy: MatchStrategy
  let transformNew: (newString: string) => string

  if (resolved !== null) {
    searchText = resolved.searchText
    strategy = resolved.strategy
    transformNew = resolved.transformNew
    const haystack =
      strategy === 'quotes' ? normalizeCurlyQuotes(fileText) : fileText

    // Delete-newline heuristic: deleting text usually means deleting its
    // line break too. Widens whenever a trailing break is present, so the
    // emptied line disappears instead of leaving a blank.
    if (newString === '' && haystack.includes(searchText + '\n')) {
      searchText = searchText + '\n'
    }

    const offsets = findAllOffsets(haystack, searchText)
    if (offsets.length === 0) {
      // The quote-normalized haystack can contain a match the raw text
      // lacks only via widening; belt-and-braces not-found guard.
      return notFound()
    }
    spans = spansFromOffsets(searchText, offsets, lineOffsets)
  } else {
    // Last repair: whole-line whitespace tolerance for multi-line copies.
    const wsSpans = findWhitespaceSpans(fileText, oldString, lineOffsets)
    if (wsSpans === null) return notFound()
    if (newString === '') {
      // Same delete-newline heuristic, applied per span.
      for (const s of wsSpans) {
        if (fileText[s.offset + s.length] === '\n') s.length += 1
      }
    }
    spans = wsSpans
    strategy = 'whitespace'
    // Seen-content checks reference one representative text: the first
    // span's exact bytes from disk.
    const first = spans[0]!
    searchText = fileText.slice(first.offset, first.offset + first.length)
    transformNew = n => n
  }

  if (!replaceAll && spans.length > 1) {
    return {
      ok: false,
      failure: {
        message: `Found ${spans.length} matches of the string to replace, but replace_all is false. Matches start at lines: ${matchLineList(spans)}. To replace only one occurrence, extend old_string with more surrounding lines until exactly one copy matches (line numbers above tell you where the copies are). To replace all occurrences, set replace_all to true.\nString: ${oldString}`,
        errorCode: 9,
      },
    }
  }

  // Spans index the original text under every strategy: the quotes haystack is
  // a length-preserving normalization of it, so splicing against fileText keeps
  // untouched regions (including their curly quotes) byte-identical.
  const written = transformNew(newString)
  const ordered = [...spans].sort((a, b) => a.offset - b.offset)
  let updatedContent = ''
  let last = 0
  for (const span of ordered) {
    updatedContent += fileText.slice(last, span.offset) + written
    last = span.offset + span.length
  }
  updatedContent += fileText.slice(last)

  return {
    ok: true,
    plan: { updatedContent, searchText, strategy, spans },
  }
}
