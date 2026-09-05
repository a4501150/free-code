// ---------------------------------------------------------------------------
// readFileInRange — line-oriented file reader with two code paths
// ---------------------------------------------------------------------------
//
// Returns lines [offset, offset + maxLines) from a file.
//
// Fast path (regular files < 10 MB):
//   Opens the file, stats the fd, reads the whole file with readFile(),
//   then splits lines in memory.  This avoids the per-chunk async overhead
//   of createReadStream and is ~2x faster for typical source files.
//
// Streaming path (large files, pipes, devices, etc.):
//   Uses createReadStream with manual indexOf('\n') scanning.  Content is
//   only accumulated for lines inside the requested range — lines outside
//   the range are counted (for totalLines) but discarded, so reading line
//   1 of a 100 GB file won't balloon RSS.
//
//   All event handlers (streamOnOpen/Data/End) are module-level named
//   functions with zero closures.  State lives in a StreamState object;
//   handlers access it via `this`, bound at registration time.
//
//   Lifecycle: `open`, `end`, and `error` use .once() (auto-remove).
//   `data` fires until the stream ends or is destroyed — either way the
//   stream and state become unreachable together and are GC'd.
//
//   On error (including maxBytes exceeded), stream.destroy(err) emits
//   'error' → reject (passed directly to .once('error')).
//
// Both paths strip a leading BOM and \r (CRLF → LF).  Files whose first two
// bytes are the UTF-16LE BOM are decoded as UTF-16LE so the returned lines
// match what the Edit tool reads and re-writes.
//
// With options.includeHashlineLabels the result also carries hashline labels
// computed over the WHOLE file (the displayed slice must show the same label
// strings a full-file Read would show).  The fast path computes them from the
// in-memory content; the streaming path re-reads the file in a second pass
// that counts collisions only for the selected lines' hash suffixes, and
// retries once when mtime moves between the passes.
//
// mtime comes from fstat/stat on the already-open fd — no extra open().
//
// maxBytes behavior depends on options.truncateOnByteLimit:
//   false (default): legacy semantics — throws FileTooLargeError if the FILE
//     size (fast path) or total streamed bytes (streaming) exceeds maxBytes.
//   true: caps SELECTED OUTPUT at maxBytes.  Stops at the last complete line
//     that fits; sets truncatedByBytes in the result.  Never throws.
// ---------------------------------------------------------------------------

import { createReadStream, fstat } from 'fs'
import { open as fsOpen, stat as fsStat, readFile } from 'fs/promises'
import type { HashlineLabelSet } from './hashline.js'
import { computeHashlineLabels, hashLengthForLineCount } from './hashline.js'
import { djb2Hash } from './hash.js'
import { formatFileSize } from './format.js'

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
  /** Whole-file hashline labels; present when includeHashlineLabels was set. */
  hashline?: HashlineLabelSet
  /** true when output was clipped to maxBytes under truncate mode */
  truncatedByBytes?: boolean
}

export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,
    public maxSizeBytes: number,
  ) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'FileTooLargeError'
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: { truncateOnByteLimit?: boolean; includeHashlineLabels?: boolean },
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted()
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false
  const includeHashlineLabels = options?.includeHashlineLabels ?? false

  // stat to decide the code path and guard against OOM.
  // For regular files under 10 MB: readFile + in-memory split (fast).
  // Everything else (large files, FIFOs, devices): streaming.
  const stats = await fsStat(filePath)

  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    )
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    if (
      !truncateOnByteLimit &&
      maxBytes !== undefined &&
      stats.size > maxBytes
    ) {
      throw new FileTooLargeError(stats.size, maxBytes)
    }

    const buffer = await readFile(filePath, { signal })
    return readFileInRangeFast(
      decodeFileBuffer(buffer),
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined,
      includeHashlineLabels,
    )
  }

  const result = await readFileInRangeStreaming(
    filePath,
    offset,
    maxLines,
    maxBytes,
    truncateOnByteLimit,
    signal,
  )
  if (includeHashlineLabels) {
    for (let attempt = 0; ; attempt++) {
      const labels = await computeStreamingLabels(
        filePath,
        offset,
        result.lineCount,
        result.totalLines,
        result.content,
        signal,
      )
      result.hashline = labels.hashline
      if (labels.mtimeMs === result.mtimeMs || attempt > 0) {
        // mtime moved under the second pass; one restart, then accept the
        // best-effort labels (only base length / collision counts can drift).
        if (labels.mtimeMs !== result.mtimeMs) {
          result.mtimeMs = labels.mtimeMs
        }
        break
      }
      const fresh = await readFileInRangeStreaming(
        filePath,
        offset,
        maxLines,
        maxBytes,
        truncateOnByteLimit,
        signal,
      )
      Object.assign(result, fresh)
    }
  }
  return result
}

// Decode bytes the way the Edit tool does: UTF-16LE when the buffer opens
// with its BOM, UTF-8 otherwise; then drop the BOM character and CRLF.
function decodeFileBuffer(buffer: Buffer): string {
  const isUtf16Le =
    buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
  const text = isUtf16Le
    ? buffer.toString('utf16le').slice(1)
    : buffer.toString('utf8')
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replaceAll(
    '\r\n',
    '\n',
  )
}

// ---------------------------------------------------------------------------
// Fast path — readFile + in-memory split
// ---------------------------------------------------------------------------

function readFileInRangeFast(
  text: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
  includeHashlineLabels: boolean,
): ReadFileRangeResult {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity

  // Split lines, select range. (\r already normalized by decodeFileBuffer.)
  const selectedLines: string[] = []

  let lineIndex = 0
  let startPos = 0
  let newlinePos: number
  let selectedBytes = 0
  let truncatedByBytes = false

  function tryPush(line: string): boolean {
    if (truncateAtBytes !== undefined) {
      const sep = selectedLines.length > 0 ? 1 : 0
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line)
      if (nextBytes > truncateAtBytes) {
        truncatedByBytes = true
        return false
      }
      selectedBytes = nextBytes
    }
    selectedLines.push(line)
    return true
  }

  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      tryPush(text.slice(startPos, newlinePos))
    }
    lineIndex++
    startPos = newlinePos + 1
  }

  // Final fragment (no trailing newline).
  if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
    tryPush(text.slice(startPos))
  }
  lineIndex++

  const content = selectedLines.join('\n')
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    readBytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
    ...(includeHashlineLabels ? { hashline: computeHashlineLabels(text) } : {}),
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Streaming labels — second streaming pass over the whole file
// ---------------------------------------------------------------------------
//
// The selected lines' labels must be what a whole-file label computation
// would produce: the base length comes from the full line count, and a label
// widens only when another line shares its truncated hash. The second pass
// therefore hashes every line and counts occurrences of the selected lines'
// suffixes at each widening level. Only the counters are kept, so memory
// stays bounded like the main streaming pass.

async function computeStreamingLabels(
  filePath: string,
  offset: number,
  selectedCount: number,
  totalLines: number,
  content: string,
  signal?: AbortSignal,
): Promise<{ hashline: HashlineLabelSet; mtimeMs: number }> {
  const baseLength = hashLengthForLineCount(totalLines)
  const levels = [...new Set([baseLength, Math.min(baseLength + 2, 8), 8])]

  const selectedLines = content.split('\n')
  const fps: string[] = []
  // key = suffix at a given level; value = occurrence count across the file.
  const counters: Map<string, number>[] = levels.map(() => new Map())
  const keysPerLevel: Set<string>[] = levels.map(() => new Set())
  for (let i = 0; i < selectedCount; i++) {
    const fp = lineFingerprint(selectedLines[i] ?? '', offset + 1 + i)
    fps.push(fp)
    levels.forEach((len, li) => {
      const key = fp.slice(-len)
      keysPerLevel[li]!.add(key)
      if (!counters[li]!.has(key)) counters[li]!.set(key, 0)
    })
  }

  const mtimeMs = await hashCountPass(
    filePath,
    levels,
    keysPerLevel,
    counters,
    signal,
  )

  const labels: HashlineLabelSet['labels'] = []
  labels.length = totalLines
  for (let i = 0; i < fps.length; i++) {
    const fp = fps[i]!
    let hash = fp.slice(-baseLength)
    let collision = false
    for (const [li, len] of levels.entries()) {
      const count = counters[li]!.get(fp.slice(-len)) ?? 0
      hash = fp.slice(-len)
      collision = count > 1 && len >= 8
      if (count <= 1 || len >= 8) break
    }
    labels[offset + i] = { hash, collision }
  }
  return { hashline: { length: baseLength, labels }, mtimeMs }
}

type HashPassState = {
  levels: number[]
  keysPerLevel: Set<string>[]
  counters: Map<string, number>[]
  lineNo: number
  partial: string
  isFirstChunk: boolean
  bump: (line: string) => void
}

function hashPassOnData(this: HashPassState, rawChunk: string | Buffer): void {
  let chunk: string =
    typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8')
  if (this.isFirstChunk) {
    this.isFirstChunk = false
    if (chunk.charCodeAt(0) === 0xfeff) {
      chunk = chunk.slice(1)
    }
  }
  const data = this.partial.length > 0 ? this.partial + chunk : chunk
  this.partial = ''
  let startPos = 0
  let newlinePos: number
  while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
    this.bump(data.slice(startPos, newlinePos))
    this.lineNo++
    startPos = newlinePos + 1
  }
  this.partial = startPos < data.length ? data.slice(startPos) : ''
}

// Hash every line of the file, bumping counters for the selected keys only.
async function hashCountPass(
  filePath: string,
  levels: number[],
  keysPerLevel: Set<string>[],
  counters: Map<string, number>[],
  signal?: AbortSignal,
): Promise<number> {
  const state: HashPassState = {
    levels,
    keysPerLevel,
    counters,
    lineNo: 0,
    partial: '',
    isFirstChunk: true,
    bump: () => {},
  }
  state.bump = line => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const fp = lineFingerprint(line, state.lineNo + 1)
    levels.forEach((len, li) => {
      const key = fp.slice(-len)
      if (keysPerLevel[li]!.has(key)) {
        counters[li]!.set(key, (counters[li]!.get(key) ?? 0) + 1)
      }
    })
  }
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 512 * 1024,
      ...(signal ? { signal } : undefined),
    })
    stream.on('data', hashPassOnData.bind(state))
    stream.once('end', () => {
      state.bump(state.partial)
      // mtime AFTER hashing: the caller compares it against the main pass.
      void fsStat(filePath)
        .then(stats => resolve(stats.mtimeMs))
        .catch(() => resolve(0))
    })
    stream.once('error', reject)
  })
}

function lineFingerprint(line: string, lineNo: number): string {
  const h = djb2Hash(`${line.trim()}\n${lineNo}`) >>> 0
  return h.toString(36).padStart(8, '0').slice(-8)
}

// ---------------------------------------------------------------------------
// Streaming path — createReadStream + event handlers
// ---------------------------------------------------------------------------

type StreamState = {
  stream: ReturnType<typeof createReadStream>
  offset: number
  endLine: number
  maxBytes: number | undefined
  truncateOnByteLimit: boolean
  resolve: (value: ReadFileRangeResult) => void
  totalBytesRead: number
  selectedBytes: number
  truncatedByBytes: boolean
  currentLineIndex: number
  selectedLines: string[]
  partial: string
  isFirstChunk: boolean
  resolveMtime: (ms: number) => void
  mtimeReady: Promise<number>
}

function streamOnOpen(this: StreamState, fd: number): void {
  fstat(fd, (err, stats) => {
    this.resolveMtime(err ? 0 : stats.mtimeMs)
  })
}

function streamOnData(this: StreamState, rawChunk: string | Buffer): void {
  let chunk: string =
    typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8')
  if (this.isFirstChunk) {
    this.isFirstChunk = false
    if (chunk.charCodeAt(0) === 0xfeff) {
      chunk = chunk.slice(1)
    }
  }

  this.totalBytesRead += Buffer.byteLength(chunk)
  if (
    !this.truncateOnByteLimit &&
    this.maxBytes !== undefined &&
    this.totalBytesRead > this.maxBytes
  ) {
    this.stream.destroy(
      new FileTooLargeError(this.totalBytesRead, this.maxBytes),
    )
    return
  }

  const data = this.partial.length > 0 ? this.partial + chunk : chunk
  this.partial = ''

  let startPos = 0
  let newlinePos: number
  while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
    const inRange =
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    if (inRange) {
      let line = data.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
        if (nextBytes > this.maxBytes) {
          // Cap hit — collapse the selection range so nothing more is
          // accumulated.  Stream continues (to count totalLines).
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
        } else {
          this.selectedBytes = nextBytes
          this.selectedLines.push(line)
        }
      } else {
        this.selectedLines.push(line)
      }
    }
    this.currentLineIndex++
    startPos = newlinePos + 1
  }

  // Only keep the trailing fragment when inside the selected range.
  // Outside the range we just count newlines — discarding prevents
  // unbounded memory growth on huge single-line files.
  if (startPos < data.length) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      const fragment = data.slice(startPos)
      // In truncate mode, `partial` can grow unboundedly if the selected
      // range contains a huge single line (no newline across many chunks).
      // Once the fragment alone would overflow the remaining budget, we know
      // the completed line can never fit — set truncated, collapse the
      // selection range, and discard the fragment to stop accumulation.
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const fragBytes = this.selectedBytes + sep + Buffer.byteLength(fragment)
        if (fragBytes > this.maxBytes) {
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
          return
        }
      }
      this.partial = fragment
    }
  }
}

function streamOnEnd(this: StreamState): void {
  let line = this.partial
  if (line.endsWith('\r')) {
    line = line.slice(0, -1)
  }
  const inRange =
    this.currentLineIndex >= this.offset && this.currentLineIndex < this.endLine
  if (inRange) {
    if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
      const sep = this.selectedLines.length > 0 ? 1 : 0
      const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
      if (nextBytes > this.maxBytes) {
        this.truncatedByBytes = true
      } else {
        this.selectedLines.push(line)
      }
    } else {
      this.selectedLines.push(line)
    }
  }
  this.currentLineIndex++

  const content = this.selectedLines.join('\n')
  const truncated = this.truncatedByBytes
  this.mtimeReady.then(mtimeMs => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {}),
    })
  })
}

function readFileInRangeStreaming(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  return new Promise((resolve, reject) => {
    const state: StreamState = {
      stream: createReadStream(filePath, {
        encoding: 'utf8',
        highWaterMark: 512 * 1024,
        ...(signal ? { signal } : undefined),
      }),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: '',
      isFirstChunk: true,
      resolveMtime: () => {},
      mtimeReady: null as unknown as Promise<number>,
    }
    state.mtimeReady = new Promise<number>(r => {
      state.resolveMtime = r
    })

    state.stream.once('open', streamOnOpen.bind(state))
    state.stream.on('data', streamOnData.bind(state))
    state.stream.once('end', streamOnEnd.bind(state))
    state.stream.once('error', reject)
  })
}
