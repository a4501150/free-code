/**
 * Sync file-read path, extracted from file.ts.
 *
 * file.ts sits in the settings SCC via log.ts → types/logs.ts → types/message.ts →
 * Tool.ts → commands.ts → … Anything that needs readFileSync from file.ts
 * pulls in the whole chain. This leaf imports only fsOperations and debug,
 * both of which terminate in Node builtins.
 *
 * detectFileEncoding/detectLineEndings stay in file.ts — they call logError
 * (log.ts → SCC) on unexpected failures. The -ForResolvedPath/-ForString
 * helpers here are the pure parts; callers who need the logging wrappers
 * import from file.ts.
 */

import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'

export type LineEndingType = 'CRLF' | 'LF'

/**
 * Drop a leading BOM character. Node's readFileSync keeps it (as U+FEFF for
 * both utf8 and utf16le); readFileInRange strips it. The read-state ledger
 * stores BOM-free content everywhere so freshness compares are consistent —
 * call this wherever content enters the ledger or is compared against it.
 * Write-back paths must NOT strip: the encoding round-trip keeps the BOM.
 */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, {
    length: 4096,
  })

  // Empty files should default to utf8, not ascii
  // This fixes a bug where writing emojis/CJK to empty files caused corruption
  if (bytesRead === 0) {
    return 'utf8'
  }

  if (bytesRead >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  }

  if (
    bytesRead >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf8'
  }

  // For non-empty files, default to utf8 since it's a superset of ascii
  // and handles all Unicode characters properly
  return 'utf8'
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0
  let lfCount = 0

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++
      } else {
        lfCount++
      }
    }
  }

  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Like readFileSync but also returns the detected encoding and original line
 * ending style in one filesystem pass. Callers writing the file back (e.g.
 * FileEditTool) can reuse these instead of calling detectFileEncoding /
 * detectLineEndings separately, which would each redo safeResolvePath +
 * readSync(4KB).
 */
export function readFileSyncWithMetadata(filePath: string): {
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  const fs = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fs, filePath)

  if (isSymlink) {
    logForDebugging(`Reading through symlink: ${filePath} -> ${resolvedPath}`)
  }

  const encoding = detectEncodingForResolvedPath(resolvedPath)
  const raw = fs.readFileSync(resolvedPath, { encoding })
  // Detect line endings from the raw head before CRLF normalization erases
  // the distinction. 4096 code units is ≥ detectLineEndings's 4096-byte
  // readSync sample (line endings are ASCII, so the unit mismatch is moot).
  const lineEndings = detectLineEndingsForString(raw.slice(0, 4096))
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings,
  }
}

export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
