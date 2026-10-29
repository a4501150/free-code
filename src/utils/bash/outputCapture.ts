import { generateTaskId } from '../../Task.js'
import { getTaskOutputPath } from '../task/diskOutput.js'
import { parseCommandRaw } from './parser.js'
import { buildParsedCommandFromRoot } from './ParsedCommand.js'

export type OutputCaptureRewrite = {
  /** Command with every rewritable `>`/`>>` target replaced by the harness path. */
  rewrittenCommand: string
  /** The harness output file every rewritten target now points at. */
  harnessPath: string
  /** Task id preallocated for that file — pass as exec()'s preallocatedTaskId. */
  taskId: string
  /** The model's original redirect targets, in command order. */
  originalTargets: string[]
}

// A target word is rewritable only when it is a plain literal: anything with
// expansion ($, backtick, brace), quoting or globbing could name several
// paths or break the splice, and a wrong rewrite loses output.
const SAFE_TARGET = /^[A-Za-z0-9._/@^%+=:,~()[\]#-]+$/

/**
 * True when the only redirect operators in the command are plain `>`/`>>`
 * file redirects with literal targets. Fast pre-filter so commands without
 * any redirect (the common case) never reach the tree-sitter parse; commands
 * with heredocs, process substitution, or expansion-laden targets fall
 * through to the full parse and get declined there.
 */
export function hasRewritableRedirectSyntax(command: string): boolean {
  return command.includes('>')
}

/**
 * Rewrite the command's own output redirections to point at a fresh harness
 * task-output file. The child's redirected writes and the stdio fd the
 * harness opened share that file (O_APPEND keeps both appends atomic), so
 * the harness keeps capturing the full stream even when the model redirected
 * it away. Returns null when the command has no rewritable redirection —
 * the caller then execs it unchanged.
 */
export function rewriteRedirectsToHarnessFile(
  command: string,
): OutputCaptureRewrite | null {
  if (!hasRewritableRedirectSyntax(command)) return null

  const root = parseCommandRaw(command)
  if (!root) return null
  const parsed = buildParsedCommandFromRoot(command, root)
  const nodes = parsed.getRedirectionNodes()
  if (nodes.length === 0) return null

  // Byte offsets, reverse-sorted for splice-from-behind.
  const targets = nodes
    .filter(n => SAFE_TARGET.test(n.target))
    .sort((a, b) => b.targetStartIndex - a.targetStartIndex)
  if (targets.length === 0) return null

  const taskId = generateTaskId('local_bash')
  const harnessPath = getTaskOutputPath(taskId)
  const replacement = Buffer.from(harnessPath, 'utf8')

  let bytes = Buffer.from(command, 'utf8')
  for (const node of targets) {
    bytes = Buffer.concat([
      bytes.subarray(0, node.targetStartIndex),
      replacement,
      bytes.subarray(node.targetEndIndex),
    ])
  }

  return {
    rewrittenCommand: bytes.toString('utf8'),
    harnessPath,
    taskId,
    originalTargets: nodes.map(n => n.target),
  }
}

// --- Trailing tail/head stage strip -----------------------------------------

export type OutputLimiterStrip = {
  /** Command with every trailing tail/head stage removed. */
  strippedCommand: string
}

// Strict trailing-stage forms: `tail`/`head` with a literal line count
// (`-8`, `-n 8`, `-n8`) or none (both default to 10 lines). Anything else —
// `-f`/`-F` (follow), `-c` (bytes), `+N` (from-line), file operands, extra
// flags, a stage carrying its own redirect — either changes semantics or
// bounds delivery in ways the stripped execution would not reproduce, and is
// left to execute exactly as written.
const TAIL_STAGE = /^tail(?:\s+(?:-n\s*(\d+)|-(\d+)))?$/
const HEAD_STAGE = /^head(?:\s+(?:-n\s*(\d+)|-(\d+)))?$/

/**
 * Strip one trailing `| tail …` / `| head …` stage: returns the command
 * without it, or null when the last pipeline stage is not a strict
 * tail/head form. Uses the rightmost pipe's BYTE offset (tree-sitter
 * offsets are UTF-8 bytes; a string slice would land mid-token after
 * multi-byte characters) — a pipe inside a command substitution can be the
 * rightmost pipe, but then the trailing text carries the closing `)` and
 * fails the strict form, so nested pipes decline naturally.
 */
function tryStripOneStage(command: string): string | null {
  const root = parseCommandRaw(command)
  if (!root) return null
  const parsed = buildParsedCommandFromRoot(command, root)
  const lastPipe = parsed.getLastPipePosition()
  if (lastPipe === null) return null

  const bytes = Buffer.from(command, 'utf8')
  const stage = bytes
    .subarray(lastPipe + 1)
    .toString('utf8')
    .trim()
  if (!TAIL_STAGE.test(stage) && !HEAD_STAGE.test(stage)) return null

  const stripped = bytes.subarray(0, lastPipe).toString('utf8').trimEnd()
  return stripped === '' ? null : stripped
}

/**
 * Pre-training habit: models end commands with `| tail`/`| head` to cap
 * their own context. Executing that stage would truncate the stream BEFORE
 * the harness captures it — the user's live output view reads the same file
 * the capture writes — so every STRICT trailing tail/head stage is stripped
 * and the complete stream captured instead. The model-facing delivery caps
 * itself as usual (inline under the limit, else preview + file path + exit
 * code). Chains (`cmd | tail -20 | head -5`) strip one stage per iteration.
 * Returns null when nothing was strippable — the caller execs unchanged.
 */
export function stripTrailingOutputLimiters(command: string): string | null {
  let current = command
  let strippedAny = false
  // Each iteration removes the rightmost pipe, so the loop terminates.
  while (true) {
    const next = tryStripOneStage(current)
    if (next === null) break
    current = next
    strippedAny = true
  }
  return strippedAny ? current : null
}

// PowerShell file redirection: `[n]>` / `[n]>>` followed by a bare literal
// path. Anything quoted, parenthesized (subexpression), or variable-laden is
// declined — same fail-closed rule as the POSIX rewrite.
const PS_REDIRECT_TARGET = /(\d*>>?)\s+([A-Za-z0-9._/@^%+=:,~()[\]#-]+)/g

/**
 * PowerShell variant of the redirect rewrite: only plain `>`/`>>`/`n>` file
 * targets with literal paths are rewritten (stderr merges `2>&1` carries no
 * target and is left alone). Declines any command whose redirect set it
 * cannot fully account for.
 */
export function rewritePsRedirectsToHarnessFile(
  command: string,
): OutputCaptureRewrite | null {
  if (!command.includes('>')) return null
  const taskId = generateTaskId('local_bash')
  const harnessPath = getTaskOutputPath(taskId)
  const originalTargets: string[] = []
  const rewritten = command.replace(
    PS_REDIRECT_TARGET,
    (_m, op: string, target: string) => {
      originalTargets.push(target)
      return `${op} ${harnessPath}`
    },
  )
  if (originalTargets.length === 0) return null
  return { rewrittenCommand: rewritten, harnessPath, taskId, originalTargets }
}
