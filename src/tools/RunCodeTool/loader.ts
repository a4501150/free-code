// Executes a model-authored TypeScript script in-process without a module
// loader. The compiled single-file binary cannot import() files from disk, so
// the pipeline is: Bun.Transpiler (TS -> JS, erases `import type`), then a
// rewrite of the remaining ESM import declarations into destructurings of
// namespaces resolved by the caller, then AsyncFunction with injected globals.
// Dynamic import() calls get the same treatment — node:*/bun:* builtins
// resolve here via require, everything else routes through resolveNamespace —
// so the executed body contains no import() at all (an AsyncFunction body has
// no module loader of its own).
// Validated against the bytecode build in tests/unit/runCode.test.ts.

import { createRequire } from 'node:module'

export type NamespaceResolution =
  | { ok: true; ns: Record<string, unknown>; exports?: string[] }
  | { ok: false; error: string }

export type ScriptGlobals = {
  /** Routes `import ... from "mcp/<server>"` and `"freecode:builtins"`. */
  resolveNamespace: (spec: string) => NamespaceResolution
  signal: AbortSignal
  /** Object shared across every run in this session, injected as `state`. */
  state?: Record<string, unknown>
  /** Extra script-visible globals beyond console/signal (e.g. freecode). */
  extraGlobals?: Record<string, unknown>
}

export type ScriptRunResult =
  | { ok: true; logs: string[] }
  | { ok: false; error: string; logs: string[] }

const IMPORT_DECL = /^import\s+([\s\S]*?)\s*from\s*["']([^"']+)["'];?[ \t]*$/gm
const BARE_IMPORT = /^import\s*["']([^"']+)["'];?[ \t]*$/gm
const EXPORTABLE =
  /^export\s+(?=(?:const\s)|(?:let\s)|(?:var\s)|(?:function\s)|(?:async\s+function\s)|(?:class\s))/gm
const DYNAMIC_IMPORT_CALL = /\bimport\s*\(/g
const MAX_LOG_LINE_CHARS = 4000

const scriptTranspiler = new Bun.Transpiler({ loader: 'ts' })
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>

const nativeModuleCache = new Map<string, Record<string, unknown>>()
const requireBuiltin = createRequire(import.meta.url)

function isNativeBuiltinSpec(spec: string): boolean {
  return spec.startsWith('node:') || spec.startsWith('bun:')
}

// Builtins resolve synchronously so import rewriting stays a sync transform.
function resolveNativeBuiltin(spec: string): NamespaceResolution {
  const cached = nativeModuleCache.get(spec)
  if (cached) return { ok: true, ns: cached }
  try {
    const ns = requireBuiltin(spec) as Record<string, unknown>
    nativeModuleCache.set(spec, ns)
    return { ok: true, ns }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Reads the argument of an `import(` call as a plain string literal. Anything
// else (computed specifiers, escapes) cannot be resolved without executing the
// script, so it is reported as an error instead.
function readDynamicImportSpec(
  body: string,
  argStart: number,
): { spec: string; end: number } | { error: string } {
  let i = argStart
  while (i < body.length && /\s/.test(body[i]!)) i++
  const quote = body[i]
  if (quote !== '"' && quote !== "'") {
    return {
      error:
        'Dynamic import() requires a single plain string literal specifier.',
    }
  }
  i++
  let spec = ''
  while (i < body.length && body[i] !== quote) {
    if (body[i] === '\\') {
      return {
        error:
          'Dynamic import() specifiers with escape sequences are not supported.',
      }
    }
    spec += body[i]
    i++
  }
  if (i >= body.length) {
    return { error: 'Unterminated dynamic import() specifier.' }
  }
  i++
  while (i < body.length && /\s/.test(body[i]!)) i++
  if (body[i] !== ')') {
    return {
      error: 'Dynamic import() takes only a single string literal argument.',
    }
  }
  return { spec, end: i + 1 }
}

function inspectValue(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return Bun.inspect(v, { depth: 4 })
  } catch {
    return String(v)
  }
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map(a => inspectValue(a))
    .join(' ')
    .slice(0, MAX_LOG_LINE_CHARS)
}

type ParsedImport =
  | { kind: 'named'; spec: string; bindings: [string, string][] }
  | { kind: 'namespace'; spec: string; local: string }
  | { kind: 'bare'; spec: string }
  | { kind: 'invalid'; spec: string; reason: string }

function parseImportClause(clause: string, spec: string): ParsedImport {
  const trimmed = clause.trim()
  if (trimmed === '') return { kind: 'bare', spec }
  if (trimmed.startsWith('{')) {
    const close = trimmed.lastIndexOf('}')
    const inner = trimmed.slice(1, close)
    const bindings: [string, string][] = []
    for (const part of inner.split(',')) {
      const item = part.trim()
      if (item === '') continue
      const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(item)
      if (asMatch) {
        bindings.push([asMatch[1]!, asMatch[2]!])
      } else if (/^\S+$/.test(item)) {
        bindings.push([item, item])
      } else {
        return {
          kind: 'invalid',
          spec,
          reason: `unsupported import specifier "${item}"`,
        }
      }
    }
    if (trimmed.slice(close + 1).trim() !== '') {
      return {
        kind: 'invalid',
        spec,
        reason: `clause "{...}" cannot be combined with other import forms`,
      }
    }
    return { kind: 'named', spec, bindings }
  }
  const nsMatch = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(trimmed)
  if (nsMatch) return { kind: 'namespace', spec, local: nsMatch[1]! }
  return {
    kind: 'invalid',
    spec,
    reason: `default imports are not supported (clause "${trimmed}")`,
  }
}

function rewriteBinding(parsed: ParsedImport, nsIndex: number): string {
  if (parsed.kind === 'namespace') {
    return `const ${parsed.local} = ns(${nsIndex});`
  }
  if (parsed.kind === 'named') {
    const pairs = parsed.bindings
      .map(([o, l]) => (o === l ? o : `${o}: ${l}`))
      .join(', ')
    return `const { ${pairs} } = ns(${nsIndex});`
  }
  return ''
}

export async function runScript(
  code: string,
  globals: ScriptGlobals,
): Promise<ScriptRunResult> {
  const logs: string[] = []
  const fail = (error: string): ScriptRunResult => ({ ok: false, error, logs })

  let js: string
  try {
    js = scriptTranspiler.transformSync(code)
  } catch (e) {
    return fail(
      `Syntax error in script: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (/^export\s+default\b/m.test(js) || /^export\s*\{/m.test(js)) {
    return fail(
      'Only plain `export const/function/class` declarations are allowed.',
    )
  }
  let body = js.replace(EXPORTABLE, '')
  if (/^export\b/m.test(body)) {
    return fail(
      'Only plain `export const/function/class` declarations are allowed.',
    )
  }

  const resolved: Record<string, unknown>[] = []
  let error: string | null = null

  const resolveForSpec = (spec: string): NamespaceResolution =>
    isNativeBuiltinSpec(spec)
      ? resolveNativeBuiltin(spec)
      : globals.resolveNamespace(spec)

  // Dynamic import() calls: node:*/bun:* resolve natively here, everything
  // else routes through resolveNamespace (catalog namespaces and bundled
  // modules alike). Every occurrence is rewritten to a namespace lookup, so
  // the executed body never contains import().
  let out = ''
  let cursor = 0
  for (const match of body.matchAll(DYNAMIC_IMPORT_CALL)) {
    const read = readDynamicImportSpec(body, match.index + match[0].length)
    if ('error' in read) return fail(read.error)
    const resolution = resolveForSpec(read.spec)
    if (!resolution.ok) {
      return fail(`Cannot import "${read.spec}": ${resolution.error}`)
    }
    out += body.slice(cursor, match.index)
    resolved.push(resolution.ns)
    out += `Promise.resolve(ns(${resolved.length - 1}))`
    cursor = read.end
  }
  body = out + body.slice(cursor)

  const process = (clause: string | null, spec: string): string => {
    const parsed: ParsedImport =
      clause === null ? { kind: 'bare', spec } : parseImportClause(clause, spec)
    if (parsed.kind === 'invalid') {
      error = parsed.reason
      return ''
    }
    if (isNativeBuiltinSpec(spec) && parsed.kind === 'bare') {
      // A builtin side-effect import has nothing to bind; drop it.
      return ''
    }
    const resolution = resolveForSpec(spec)
    if (!resolution.ok) {
      error = `Cannot import "${spec}": ${resolution.error}`
      return ''
    }
    if (parsed.kind === 'named') {
      const available = resolution.exports ?? Object.keys(resolution.ns)
      const missing = parsed.bindings
        .map(([o]) => o)
        .filter(o => !available.includes(o))
      if (missing.length > 0) {
        error = `"${parsed.spec}" has no export(s) ${missing
          .map(o => `'${o}'`)
          .join(', ')}. Available: ${available.join(', ')}`
        return ''
      }
    }
    resolved.push(resolution.ns)
    return rewriteBinding(parsed, resolved.length - 1)
  }

  body = body.replace(IMPORT_DECL, (_m, clause: string, spec: string) => {
    if (error) return _m
    return process(clause, spec)
  })
  body = body.replace(BARE_IMPORT, (m, spec: string) => {
    if (error) return m
    return process(null, spec)
  })
  if (error) return fail(error)
  if (/^\s*import\b/m.test(body)) {
    return fail(
      `Unrecognized import declaration: ${
        /^\s*import.*$/m.exec(body)?.[0]?.trim() ?? 'import'
      }`,
    )
  }

  const console_ = {
    log: (...args: unknown[]) => logs.push(formatLogArgs(args)),
    info: (...args: unknown[]) => logs.push(formatLogArgs(args)),
    debug: (...args: unknown[]) => logs.push(formatLogArgs(args)),
    warn: (...args: unknown[]) => logs.push(`[warn] ${formatLogArgs(args)}`),
    error: (...args: unknown[]) => logs.push(`[error] ${formatLogArgs(args)}`),
  }
  const ns = (i: number): Record<string, unknown> => resolved[i]!

  const extraNames = Object.keys(globals.extraGlobals ?? {})
  const fn = new AsyncFunction(
    'ns',
    'console',
    'signal',
    'state',
    ...extraNames,
    body,
  )

  let abortHandler: (() => void) | undefined
  const run = fn(
    ns,
    console_,
    globals.signal,
    globals.state ?? {},
    ...Object.values(globals.extraGlobals ?? {}),
  )
  try {
    await new Promise<unknown>((resolve, reject) => {
      if (globals.signal.aborted) {
        reject(new Error('Script interrupted.'))
        return
      }
      abortHandler = () => reject(new Error('Script interrupted.'))
      globals.signal.addEventListener('abort', abortHandler, { once: true })
      run.then(resolve, reject)
    })
    return { ok: true, logs }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  } finally {
    if (abortHandler) {
      globals.signal.removeEventListener('abort', abortHandler)
    }
  }
}
