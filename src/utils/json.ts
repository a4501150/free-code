import { open, readFile, stat } from 'fs/promises'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
} from 'jsonc-parser/lib/esm/main.js'
import { stripBOM } from './jsonRead.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonStringify } from './slowOperations.js'

type CachedParse = { ok: true; value: unknown } | { ok: false }

// Memoized inner parse. Uses a discriminated-union wrapper because:
// 1. memoizeWithLRU requires NonNullable<unknown>, but JSON.parse can return
//    null (e.g. JSON.parse("null")).
// 2. Invalid JSON must also be cached — otherwise repeated calls with the same
//    bad string re-parse and re-log every time (behavioral regression vs the
//    old lodash memoize which wrapped the entire try/catch).
// Bounded to 50 entries to prevent unbounded memory growth — previously this
// used lodash memoize which cached every unique JSON string forever (settings,
// .mcp.json, notebooks, tool results), causing a significant memory leak.
// Note: shouldLogError is intentionally excluded from the cache key (matching
// lodash memoize default resolver = first arg only).
// Skip caching above this size — the LRU stores the full string as the key,
// so a 200KB config file would pin ~10MB in #keyList across 50 slots. Large
// inputs like ~/.claude.json also change between reads (numStartups bumps on
// every CC startup), so the cache never hits anyway.
const PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024

function parseJSONUncached(json: string, shouldLogError: boolean): CachedParse {
  try {
    return { ok: true, value: JSON.parse(stripBOM(json)) }
  } catch (e) {
    if (shouldLogError) {
      logError(e)
    }
    return { ok: false }
  }
}

const parseJSONCached = memoizeWithLRU(parseJSONUncached, json => json, 50)

// Important: memoized for performance (LRU-bounded to 50 entries, small inputs only).
export const safeParseJSON = Object.assign(
  function safeParseJSON(
    json: string | null | undefined,
    shouldLogError: boolean = true,
  ): unknown {
    if (!json) return null
    const result =
      json.length > PARSE_CACHE_MAX_KEY_BYTES
        ? parseJSONUncached(json, shouldLogError)
        : parseJSONCached(json, shouldLogError)
    return result.ok ? result.value : null
  },
  { cache: parseJSONCached.cache },
)

/**
 * Safely parse JSON with comments (jsonc).
 * Accepts line comments, block comments, and trailing commas.
 * Strict-JSON compatible: all `safeParseJSON` input also parses here.
 *
 * @param shouldLogError defaults to true; pass false for paths that
 *        surface their own validation errors and want to avoid double-logging
 *        (e.g. settings parsing before schema validation).
 */
export function safeParseJSONC(
  json: string | null | undefined,
  shouldLogError: boolean = true,
): unknown {
  if (!json) {
    return null
  }
  try {
    // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
    const errors: ParseError[] = []
    const result = parseJsonc(stripBOM(json), errors, {
      allowTrailingComma: true,
    })
    // jsonc-parser is lenient by default (returns partial trees on syntax
    // errors). Match safeParseJSON's strict behavior: any syntax error → null.
    if (errors.length > 0) {
      if (shouldLogError) {
        logError(
          new Error(
            `JSONC parse error (code ${errors[0]!.error}) at offset ${errors[0]!.offset}`,
          ),
        )
      }
      return null
    }
    return result
  } catch (e) {
    if (shouldLogError) {
      logError(e)
    }
    return null
  }
}

/**
 * Modify a jsonc string by adding a new item to an array, preserving comments and formatting.
 * @param content The jsonc string to modify
 * @param newItem The new item to add to the array
 * @returns The modified jsonc string
 */
/**
 * Bun.JSONL.parseChunk if available, false otherwise.
 * Supports both strings and Buffers, minimizing memory usage and copies.
 * Also handles BOM stripping internally.
 */
type BunJSONLParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }

const bunJSONLParse: BunJSONLParseChunk | false = (() => {
  if (typeof Bun === 'undefined') return false
  const b = Bun as Record<string, unknown>
  const jsonl = b.JSONL as Record<string, unknown> | undefined
  if (!jsonl?.parseChunk) return false
  return jsonl.parseChunk as BunJSONLParseChunk
})()

function parseJSONLBun<T>(data: string | Buffer): T[] {
  const parse = bunJSONLParse as BunJSONLParseChunk
  const len = data.length
  const result = parse(data)
  if (!result.error || result.done || result.read >= len) {
    return result.values as T[]
  }
  // Had an error mid-stream — collect what we got and keep going
  let values = result.values as T[]
  let offset = result.read
  while (offset < len) {
    const newlineIndex =
      typeof data === 'string'
        ? data.indexOf('\n', offset)
        : data.indexOf(0x0a, offset)
    if (newlineIndex === -1) break
    offset = newlineIndex + 1
    const next = parse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values as T[])
    }
    if (!next.error || next.done || next.read >= len) break
    offset = next.read
  }
  return values
}

function parseJSONLBuffer<T>(buf: Buffer): T[] {
  const bufLen = buf.length
  let start = 0

  // Strip UTF-8 BOM (EF BB BF)
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3
  }

  const results: T[] = []
  while (start < bufLen) {
    let end = buf.indexOf(0x0a, start)
    if (end === -1) end = bufLen

    const line = buf.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // Skip malformed lines
    }
  }
  return results
}

function parseJSONLString<T>(data: string): T[] {
  const stripped = stripBOM(data)
  const len = stripped.length
  let start = 0

  const results: T[] = []
  while (start < len) {
    let end = stripped.indexOf('\n', start)
    if (end === -1) end = len

    const line = stripped.substring(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // Skip malformed lines
    }
  }
  return results
}

/**
 * Parses JSONL data from a string or Buffer, skipping malformed lines.
 * Uses Bun.JSONL.parseChunk when available for better performance,
 * falls back to indexOf-based scanning otherwise.
 */
export function parseJSONL<T>(data: string | Buffer): T[] {
  if (bunJSONLParse) {
    return parseJSONLBun<T>(data)
  }
  if (typeof data === 'string') {
    return parseJSONLString<T>(data)
  }
  return parseJSONLBuffer<T>(data)
}

const MAX_JSONL_READ_BYTES = 100 * 1024 * 1024

/**
 * Reads and parses a JSONL file, reading at most the last 100 MB.
 * For files larger than 100 MB, reads the tail and skips the first partial line.
 *
 * 100 MB is more than sufficient since the longest context window we support
 * is ~2M tokens, which is well under 100 MB of JSONL.
 */
export async function readJSONLFile<T>(filePath: string): Promise<T[]> {
  const { size } = await stat(filePath)
  if (size <= MAX_JSONL_READ_BYTES) {
    return parseJSONL<T>(await readFile(filePath))
  }
  await using fd = await open(filePath, 'r')
  const buf = Buffer.allocUnsafe(MAX_JSONL_READ_BYTES)
  let totalRead = 0
  const fileOffset = size - MAX_JSONL_READ_BYTES
  while (totalRead < MAX_JSONL_READ_BYTES) {
    const { bytesRead } = await fd.read(
      buf,
      totalRead,
      MAX_JSONL_READ_BYTES - totalRead,
      fileOffset + totalRead,
    )
    if (bytesRead === 0) break
    totalRead += bytesRead
  }
  // Skip the first partial line
  const newlineIndex = buf.indexOf(0x0a)
  if (newlineIndex !== -1 && newlineIndex < totalRead - 1) {
    return parseJSONL<T>(buf.subarray(newlineIndex + 1, totalRead))
  }
  return parseJSONL<T>(buf.subarray(0, totalRead))
}

export function addItemToJSONCArray(content: string, newItem: unknown): string {
  try {
    // If the content is empty or whitespace, create a new JSON file
    if (!content || content.trim() === '') {
      return jsonStringify([newItem], null, 4)
    }

    // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
    const cleanContent = stripBOM(content)

    // Parse the content to check if it's valid JSON
    const parsedContent = parseJsonc(cleanContent)

    // If the parsed content is a valid array, modify it
    if (Array.isArray(parsedContent)) {
      // Get the length of the array
      const arrayLength = parsedContent.length

      // Determine if we are dealing with an empty array
      const isEmpty = arrayLength === 0

      // If it's an empty array we want to add at index 0, otherwise append to the end
      const insertPath = isEmpty ? [0] : [arrayLength]

      // Generate edits - we're using isArrayInsertion to add a new item without overwriting existing ones
      const edits = modify(cleanContent, insertPath, newItem, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
        isArrayInsertion: true,
      })

      // If edits could not be generated, fall back to manual JSON string manipulation
      if (!edits || edits.length === 0) {
        const copy = [...parsedContent, newItem]
        return jsonStringify(copy, null, 4)
      }

      // Apply the edits to preserve comments (use cleanContent without BOM)
      return applyEdits(cleanContent, edits)
    }
    // If it's not an array at all, create a new array with the item
    else {
      // If the content exists but is not an array, we'll replace it completely
      return jsonStringify([newItem], null, 4)
    }
  } catch (e) {
    // If parsing fails for any reason, log the error and fallback to creating a new JSON array
    logError(e)
    return jsonStringify([newItem], null, 4)
  }
}

/**
 * Top-level keys in settings-style JSONC files that should receive
 * 2-level (child-by-child) writes in `patchJsoncFile` so that sibling
 * children's inside-subtree comments survive when only one child is edited.
 *
 * Exported so callers (e.g. settings writer's diff builder) can mirror
 * the same set when computing the partial to pass in.
 */
export const SETTINGS_DEEP_KEYS: ReadonlySet<string> = new Set([
  'providers',
  'mcpServers',
  'permissions',
  'pluginConfigs',
  'env',
  'extraKnownMarketplaces',
])

/**
 * Set (or delete) a value at a JSON path in a JSONC document, preserving
 * all comments and formatting outside the modified node.
 *
 * - Pass `value = undefined` to delete the key.
 * - `path` follows jsonc-parser conventions: string segments for object
 *   keys, numbers for array indices. E.g. `['providers', 'claude-ai']`.
 *
 * Invariants:
 *   - Comments OUTSIDE the replaced node survive.
 *   - Comments INSIDE a replaced object/array subtree are lost (the
 *     subtree is replaced with `JSON.stringify(value)`).
 *   - Sibling keys and their surrounding comments are preserved.
 *
 * Returns the modified JSONC string. Returns `content` unchanged on error.
 */
export function modifyJsoncKey(
  content: string,
  path: (string | number)[],
  value: unknown,
  opts: { tabSize?: number } = {},
): string {
  try {
    const clean = stripBOM(content)
    const edits = modify(clean, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: opts.tabSize ?? 2 },
    })
    if (!edits || edits.length === 0) return clean
    return applyEdits(clean, edits)
  } catch (e) {
    logError(e)
    return content
  }
}

/**
 * Apply a partial update to a JSONC document, preserving comments.
 *
 * Algorithm:
 *   For each key in `partial`:
 *     - If key is in `deepKeys` AND the new value is a plain object:
 *         Ensure the parent exists (seed `{}` if missing), then
 *         per-child: `modifyJsoncKey(content, [key, childKey], childValue)`.
 *         This preserves comments on sibling children that the caller
 *         did NOT include in `partial[key]`.
 *     - Else: `modifyJsoncKey(content, [key], newValue)` — whole-value replace.
 *   A value of `undefined` deletes the corresponding key.
 *
 * Contract for callers with deep keys: include ONLY the children you want
 * written. Every child listed is re-emitted (its inside-subtree comments
 * die). Children omitted from `partial[deepKey]` are untouched.
 *
 * If `content` is empty/null, returns a freshly-serialized JSON document
 * with trailing newline (no comments to preserve).
 */
export function patchJsoncFile(
  content: string | null | undefined,
  partial: Record<string, unknown>,
  opts: { deepKeys?: ReadonlySet<string>; tabSize?: number } = {},
): string {
  const deepKeys = opts.deepKeys ?? SETTINGS_DEEP_KEYS
  const tabSize = opts.tabSize ?? 2

  // Fresh file: no comments to preserve, emit plain JSON.
  if (!content || content.trim() === '') {
    return jsonStringify(partial, null, tabSize) + '\n'
  }

  let result = stripBOM(content)

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

  for (const [k, v] of Object.entries(partial)) {
    if (deepKeys.has(k) && isPlainObject(v)) {
      // Seed the parent object if missing or of wrong shape, so per-child
      // writes have an object to land in. Avoids depending on jsonc-parser's
      // intermediate-node auto-creation edge.
      const parsed = parseJsonc(result) as Record<string, unknown> | null
      const existing = parsed?.[k]
      if (!isPlainObject(existing)) {
        result = modifyJsoncKey(result, [k], {}, { tabSize })
      }
      for (const [childKey, childValue] of Object.entries(v)) {
        result = modifyJsoncKey(result, [k, childKey], childValue, { tabSize })
      }
    } else {
      result = modifyJsoncKey(result, [k], v, { tabSize })
    }
  }

  return result.endsWith('\n') ? result : result + '\n'
}
