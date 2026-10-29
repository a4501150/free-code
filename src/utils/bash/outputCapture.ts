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
