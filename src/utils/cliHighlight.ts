// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because this file's `typeof import('highlight.js')` pulls
// lib.dom in. tsconfig has lib: ["ESNext"] only — fixing the actual DOM-type
// deps is a separate sweep; this ref preserves the status quo.
/// <reference lib="dom" />

import * as cliHighlight from 'cli-highlight'
import hljs from 'highlight.js'
import { extname } from 'path'

export type CliHighlight = {
  highlight: typeof cliHighlight.highlight
  supportsLanguage: typeof cliHighlight.supportsLanguage
}

const CLI_HIGHLIGHT: CliHighlight = {
  highlight: cliHighlight.highlight,
  supportsLanguage: cliHighlight.supportsLanguage,
}

// Single shared promise. React.use() tracks promises by identity — returning
// a fresh `Promise.resolve(CLI_HIGHLIGHT)` on every call made the <Markdown>
// Suspense boundary re-evaluate on every parent re-render, briefly rendering
// the highlight={null} fallback (visible as a syntax-highlight blink when the
// parent re-renders on every keystroke, e.g. the Exit Plan Mode feedback input).
const CLI_HIGHLIGHT_PROMISE: Promise<CliHighlight | null> =
  Promise.resolve(CLI_HIGHLIGHT)

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  return CLI_HIGHLIGHT_PROMISE
}

/**
 * eg. "foo/bar.ts" → "TypeScript". Reads highlight.js's language registry.
 * All callers are telemetry (OTel counter attributes, permission-dialog unary
 * events) — none block on this.
 */
export async function getLanguageName(file_path: string): Promise<string> {
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  return (
    (hljs.getLanguage(ext) as { name?: string } | undefined)?.name ?? 'unknown'
  )
}
