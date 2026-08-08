import { parseCommand } from './parser.js'
import type { TsNode } from './bashParser.js'

/**
 * Canonical safe-wrapper stripping: `time`, `nohup`, `timeout`, `nice`, `env`,
 * `stdbuf`.
 *
 * These commands exec their trailing arguments, so every security check that
 * asks "what command is this?" must see the WRAPPED command, not the wrapper.
 * This module is the single source of truth for that question.
 *
 * SECURITY: this existed in three divergent copies (checkSemantics in ast.ts,
 * stripWrappersFromArgv in pathValidation.ts, and the regex-based
 * stripSafeWrappers in bashPermissions.ts). Any asymmetry is exploitable: one
 * layer resolves to the real command while another still sees the wrapper, so
 * a deny rule or a contextual gate silently fails to match. This bit `nice`
 * once (`nice rm -rf /` evaded a Bash(rm:*) deny; `cd evil && nice git status`
 * evaded the bare-repo gate) and was fixed in only two of the three copies,
 * leaving `env` and space-separated/long-form `stdbuf` open. Add wrappers here
 * and nowhere else.
 *
 * Callers decide what an `unrecognized` result means for them: checkSemantics
 * turns it into a semantic failure (ask), while the path/rule layers leave the
 * argv unchanged — safe because checkSemantics runs first and already rejected.
 */

/** Signals and durations only — rejects `$ ( ) \` | ; &` and newlines, so
 * `timeout -k$(id) 10 ls` cannot strip to `ls` while bash expands `$(id)`
 * during word splitting BEFORE timeout runs. */
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/
const TIMEOUT_LONG_FUSED_RE = /^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/
const TIMEOUT_SHORT_FUSED_RE = /^-[ks][A-Za-z0-9_.+-]+$/
/** GNU timeout parses durations with strtod and also accepts `.5`, `+5`,
 * `5e-1`, `inf` and hex floats. Anything outside this regex is unrecognized,
 * NOT ignored — `timeout .5 eval "id"` must not leave the eval unchecked. */
const TIMEOUT_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/

const NICE_ADJUSTMENT_RE = /^-?\d+$/
const NICE_LEGACY_ADJUSTMENT_RE = /^-\d+$/
/** walkArgument returns raw node text for arithmetic expansion, so
 * `nice $((0-5)) jq …` arrives as `$((0-5))`. Bash expands it to the legacy
 * `-5` adjustment and execs jq; stripping one token would set the command
 * name to `$((0-5))` and skip jq's checks entirely. */
const NICE_EXPANSION_RE = /[$(`]/

const STDBUF_SHORT_SEP_RE = /^-[ioe]$/
const STDBUF_SHORT_FUSED_RE = /^-[ioe]./
const STDBUF_LONG_RE = /^--(input|output|error)=/

export type WrapperStripResult =
  /** Effective argv after removing every recognized wrapper. May be unchanged
   * (no wrapper present), and may still be the wrapper itself when it has no
   * wrapped command — bare `env` and `timeout` are ordinary commands. */
  | { kind: 'ok'; argv: string[] }
  /** The wrapped command could not be located. Fail closed; never fall back to
   * treating the wrapper name as the command. */
  | { kind: 'unrecognized'; reason: string }

/** Index just past the wrapper's flags, or a reason why they're unparseable. */
type SkipResult = { index: number } | { reason: string }

function skipTimeoutFlags(a: readonly string[]): SkipResult {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    ) {
      i++
    } else if (TIMEOUT_LONG_FUSED_RE.test(arg)) {
      i++
    } else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    ) {
      i += 2
    } else if (arg === '--') {
      i++
      break
    } else if (arg.startsWith('--')) {
      // Unknown long flag, or --kill-after/--signal with a non-allowlisted
      // value (e.g. a placeholder left by a command substitution).
      return {
        reason: `timeout with ${arg} flag cannot be statically analyzed`,
      }
    } else if (arg === '-v') {
      i++
    } else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    ) {
      i += 2
    } else if (TIMEOUT_SHORT_FUSED_RE.test(arg)) {
      i++
    } else if (arg.startsWith('-')) {
      return {
        reason: `timeout with ${arg} flag cannot be statically analyzed`,
      }
    } else {
      break // non-flag — should be the duration
    }
  }
  return { index: i }
}

function skipStdbufFlags(a: readonly string[]): SkipResult {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (STDBUF_SHORT_SEP_RE.test(arg) && a[i + 1]) {
      i += 2 // -o MODE
    } else if (STDBUF_SHORT_FUSED_RE.test(arg)) {
      i++ // -o0
    } else if (STDBUF_LONG_RE.test(arg)) {
      i++ // --output=MODE
    } else if (arg.startsWith('-')) {
      // `--output MODE` (space-separated long) or an unknown flag. GNU stdbuf
      // documents `=` syntax but getopt_long also accepts a separate value, so
      // we cannot enumerate these safely.
      return { reason: `stdbuf with ${arg} flag cannot be statically analyzed` }
    } else {
      break // the wrapped command
    }
  }
  return { index: i }
}

function skipEnvFlags(a: readonly string[]): SkipResult {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (arg.includes('=') && !arg.startsWith('-')) {
      i++ // VAR=val assignment
    } else if (arg === '-i' || arg === '-0' || arg === '-v') {
      i++
    } else if (arg === '-u' && a[i + 1]) {
      i += 2 // -u NAME
    } else if (arg.startsWith('-')) {
      // -S splits a string into argv (a mini-shell); -C and -P change cwd and
      // PATH so the wrapped command runs somewhere else entirely.
      return { reason: `env with ${arg} flag cannot be statically analyzed` }
    } else {
      break // the wrapped command
    }
  }
  return { index: i }
}

/** Consume a wrapper's own `--` end-of-options marker, so `nohup -- rm -- x`
 * strips to `rm -- x` rather than leaving `--` as the command name. */
function sliceAfter(a: readonly string[], i: number): string[] {
  return a.slice(a[i] === '--' ? i + 1 : i)
}

/**
 * Strip every recognized safe wrapper from `argv`, repeatedly, and return the
 * effective command's argv.
 */
export function stripWrappers(argv: readonly string[]): WrapperStripResult {
  let a: string[] = [...argv]

  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = sliceAfter(a, 1)
    } else if (a[0] === 'timeout') {
      const skipped = skipTimeoutFlags(a)
      if ('reason' in skipped) return { kind: 'unrecognized', ...skipped }
      const { index } = skipped
      const duration = a[index]
      if (duration === undefined) {
        break // `timeout` with no duration — the wrapper is the command
      }
      if (!TIMEOUT_DURATION_RE.test(duration)) {
        return {
          kind: 'unrecognized',
          reason: `timeout duration '${duration}' cannot be statically analyzed`,
        }
      }
      a = sliceAfter(a, index + 1)
    } else if (a[0] === 'nice') {
      if (a[1] === '-n' && a[2] && NICE_ADJUSTMENT_RE.test(a[2])) {
        a = sliceAfter(a, 3)
      } else if (a[1] && NICE_LEGACY_ADJUSTMENT_RE.test(a[1])) {
        a = sliceAfter(a, 2)
      } else if (a[1] && NICE_EXPANSION_RE.test(a[1])) {
        return {
          kind: 'unrecognized',
          reason: `nice argument '${a[1]}' contains expansion — cannot statically determine wrapped command`,
        }
      } else {
        a = sliceAfter(a, 1)
      }
    } else if (a[0] === 'env') {
      const skipped = skipEnvFlags(a)
      if ('reason' in skipped) return { kind: 'unrecognized', ...skipped }
      if (skipped.index >= a.length) break // bare `env` — inert
      a = a.slice(skipped.index)
    } else if (a[0] === 'stdbuf') {
      const skipped = skipStdbufFlags(a)
      if ('reason' in skipped) return { kind: 'unrecognized', ...skipped }
      // No flags consumed, or nothing after them: `stdbuf` is the command.
      if (skipped.index <= 1 || skipped.index >= a.length) break
      a = a.slice(skipped.index)
    } else {
      break
    }
  }

  return { kind: 'ok', argv: a }
}

/**
 * Convenience for the many call sites that only want the effective argv and
 * treat an unparseable wrapper as "leave it alone". Safe only where
 * checkSemantics has already run and rejected the same input.
 */
export function stripWrappersOrUnchanged(argv: string[]): string[] {
  const result = stripWrappers(argv)
  return result.kind === 'ok' ? result.argv : argv
}

/**
 * Node types whose source span is exactly one argv element. Anything else
 * (expansions, substitutions, arithmetic) means we cannot map an argv index
 * back to a source offset, so callers must not strip.
 */
const ARG_NODE_TYPES = new Set([
  'command_name',
  'word',
  'string',
  'raw_string',
  'number',
  'concatenation',
])

const REDIRECT_NODE_TYPES = new Set(['file_redirect', 'herestring_redirect'])

/**
 * Strip leading wrappers from a command STRING, returning the original source
 * from the wrapped command onward, or null when that can't be determined safely.
 *
 * Returning a slice of the original source rather than a re-serialization of
 * argv is deliberate: permission rules are matched by string prefix, so any
 * requoting would change what matches.
 *
 * Only the leading command is considered, mirroring the `^`-anchored regexes
 * this exists to correct: `env git status && ls` yields `git status && ls`.
 */
export function stripWrappersFromSource(command: string): string | null {
  // Parser offsets are UTF-8 byte offsets. They coincide with JS string indices
  // only for ASCII, and slicing on a mismatch would corrupt the command.
  if (Buffer.byteLength(command) !== command.length) return null

  const commandNode = parseCommand(command)?.commandNode
  if (!commandNode || commandNode.type !== 'command') return null

  const argNodes: TsNode[] = []
  for (const child of commandNode.children) {
    // Command-local VAR=val prefixes are not argv elements.
    if (child.type === 'variable_assignment') continue
    // Redirects are validated separately and may appear anywhere; the leading
    // wrapper tokens we care about are already collected by the time one shows.
    if (REDIRECT_NODE_TYPES.has(child.type)) break
    if (!ARG_NODE_TYPES.has(child.type)) return null
    argNodes.push(child)
  }

  // Raw node text, not resolved argv: a quoted `'env'` therefore does not match
  // the wrapper table and nothing is stripped, which is the safe direction.
  const stripped = stripWrappers(argNodes.map(n => n.text))
  if (stripped.kind !== 'ok') return null

  const removed = argNodes.length - stripped.argv.length
  if (removed <= 0) return null
  const start = argNodes[removed]?.startIndex
  if (start === undefined) return null

  return command.slice(start)
}
