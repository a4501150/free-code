/**
 * Detector for blocking waits a model issues in a FOREGROUND Bash call:
 * top-level `sleep` statements, sleeps inside loop bodies (a poll by
 * definition), and foreground `tail -f`. Feeds the wait nudge on the Bash
 * tool result (waitNudge.ts) and the guaranteed-timeout rejection in
 * BashTool.validateInput. Advisory only — never a permission decision — so
 * an unparseable command returns null (fail-open) instead of 'too-complex'.
 */

import {
  extractCommandArguments,
  parseCommandRaw,
  type Node,
} from './parser.js'

/** A literal top-level sleep at or above this many seconds is a blocking wait. */
export const TOP_LEVEL_SLEEP_THRESHOLD_S = 30

export type SleepWaitInfo = {
  /** Longest single literal `sleep` duration at statement level, in seconds.
   * Undefined when no literal-duration sleep was found (dynamic args only). */
  topSleepSeconds?: number
  /** A sleep of any duration — including a dynamic one — inside a
   * while/until/for/select body or its condition. */
  inLoop: boolean
  /** A foreground `tail -f`-style follow: never exits on its own. */
  follow: boolean
}

/** Whether a detected info crosses a nudge-worthy threshold at all. */
export function isBlockingWait(info: SleepWaitInfo | null): boolean {
  if (!info) return false
  return (
    (info.topSleepSeconds ?? 0) >= TOP_LEVEL_SLEEP_THRESHOLD_S ||
    info.inLoop ||
    info.follow
  )
}

/**
 * `sleep` duration in seconds for the literal arguments, 'dynamic' when any
 * argument is not a statically known duration, null for no arguments
 * (`sleep` with no args errors out immediately — nothing to detect).
 * Suffixes (30s, 2m, 1.5h, 1d) and multiple arguments (`sleep 1m 30`)
 * are summed per GNU sleep. `infinity` needs no parse: it is always huge.
 */
function parseSleepDuration(args: string[]): number | 'dynamic' | null {
  if (args.length === 0) return null
  let total = 0
  let dynamic = false
  for (const arg of args) {
    if (arg === 'infinity') return Number.POSITIVE_INFINITY
    const m = /^(\d+(?:\.\d+)?)([smhd])?$/i.exec(arg)
    if (m) {
      const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
      total += parseFloat(m[1]!) * (m[2] ? mult[m[2].toLowerCase()]! : 1)
    } else {
      dynamic = true
    }
  }
  return dynamic ? 'dynamic' : total
}

const TAIL_FOLLOW_ARGS = new Set([
  '-f',
  '-F',
  '--follow',
  '--follow=name',
  '--follow=descriptor',
])

/** Record one `command` node's argv into the accumulating info. */
function inspectCommand(
  argv: string[],
  inLoop: boolean,
  info: SleepWaitInfo,
): void {
  const name = argv[0]
  if (name === 'tail') {
    if (argv.some(a => TAIL_FOLLOW_ARGS.has(a))) info.follow = true
    return
  }
  if (name !== 'sleep') return
  if (inLoop) {
    info.inLoop = true
    return
  }
  const duration = parseSleepDuration(argv.slice(1))
  if (typeof duration === 'number') {
    info.topSleepSeconds = Math.max(info.topSleepSeconds ?? 0, duration)
  }
}

/**
 * Walk the AST collecting blocking waits. `a & b` backgrounds the `a` side —
 * the harness's shell returns without waiting for it, so a backgrounded
 * sleep does not block and must not be flagged: an '&' leaf sibling marks the
 * PRECEDING sibling subtree as unblocking. `function_definition` bodies run
 * only when called; call sites are separate commands, so they are skipped.
 */
function walk(
  node: Node,
  inLoop: boolean,
  backgrounded: boolean,
  info: SleepWaitInfo,
): void {
  const { type, children } = node
  if (type === 'function_definition') return
  if (type === 'command') {
    if (!backgrounded)
      inspectCommand(extractCommandArguments(node), inLoop, info)
    // Descend into argument children: a $() substitution inside a string
    // argument carries its own nested command ("$(sleep 30)" blocks
    // synchronously), which argv alone does not expose.
    for (const child of children) walk(child, inLoop, backgrounded, info)
    return
  }
  const loop = inLoop || isLoopNode(type)
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const childBackgrounded =
      backgrounded || (children[i + 1]?.type === '&' && isStatementNode(child))
    walk(child, loop, childBackgrounded, info)
  }
}

/** Only statement-bearing siblings can be backgrounded by a following '&'. */
function isStatementNode(node: Node): boolean {
  return node.type !== '&&' && node.type !== '||' && node.type !== '|'
}

function isLoopNode(type: string): boolean {
  // until and select both parse as while_statement/for_statement shapes.
  return (
    type === 'while_statement' ||
    type === 'for_statement' ||
    type === 'c_style_for_statement'
  )
}

/** Detect blocking waits in a Bash command. Null when none (or unparseable). */
export function detectBlockingWait(command: string): SleepWaitInfo | null {
  // Fast guard: no detection is possible without these words in the source
  // (same pattern as outputCapture's redirect pre-checks). Quote-obfuscated
  // argv (sl"ee"p) slips past — acceptable for an advisory detector.
  if (!command.includes('sleep') && !command.includes('tail')) return null
  const root = parseCommandRaw(command)
  if (!root) return null
  const info: SleepWaitInfo = { inLoop: false, follow: false }
  walk(root, false, false, info)
  if (info.topSleepSeconds === undefined && !info.inLoop && !info.follow) {
    return null
  }
  return info
}
