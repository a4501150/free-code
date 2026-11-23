import { generateTaskId } from '../../Task.js'
import { getTaskOutputPath } from '../task/diskOutput.js'
import { parseCommandRaw, type Node } from './parser.js'
import { buildParsedCommandFromRoot } from './ParsedCommand.js'

export type RedirectOutcome = {
  target: string
  operator: '>' | '>>'
  /** tee: dual-written to the target and captured. passthrough: left as written, not captured. */
  mode: 'tee' | 'passthrough'
}

export type OutputCaptureRewrite = {
  /**
   * Command with every tee-able redirect replaced by a `| tee [-a] <target>`
   * stage; passthrough redirects are left verbatim. Equal to the input when
   * nothing was tee-able.
   */
  rewrittenCommand: string
  /**
   * The harness output file exec() opens as the child's stdio — tee's
   * passthrough lands there, so the live views and the capture keep the
   * uncapped stream.
   */
  harnessPath: string
  /** Task id preallocated for that file — pass as exec()'s preallocatedTaskId. */
  taskId: string
  /** Every parsed `>`/`>>` file redirect, in command order, with its outcome. */
  targets: RedirectOutcome[]
}

// A target word is tee-able only when it is a plain literal: anything with
// expansion ($, backtick, brace), quoting or globbing could name several
// paths or break the splice, and a wrong rewrite loses output.
const SAFE_TARGET = /^[A-Za-z0-9._/@^%+=:,~()[\]#-]+$/

/**
 * Fast pre-filter so commands without any redirect (the common case) never
 * reach the parse. `&>`, `>&` and friends contain `>` too; the parse and the
 * candidate checks below decline them.
 */
export function hasRewritableRedirectSyntax(command: string): boolean {
  return command.includes('>')
}

// Contexts whose redirects a pipeline stage cannot reach: a tee inside a
// substitution would change the substitution's value (the redirect removes
// the stream; tee duplicates it back).
const NESTED_CONTEXTS = new Set([
  'command_substitution',
  'process_substitution',
  'subshell',
  'function_definition',
])

type CollectedRedirect = {
  /** The file_redirect node — its [start,end) span is what a tee removes. */
  node: Node
  /** The node the redirect hangs off — a pre-redirect parents `command`. */
  parentType: string
  /** The owning redirected_statement; its end (or heredoc start) is the tee insertion point. */
  owner: Node | null
  /** The pipeline enclosing the owner, for the final-stage check. */
  pipeline: Node | null
  nested: boolean
  operator: '>' | '>>' | null
  target: string | null
  fd: number
  /** Exactly one operator and one word child — `cmd >f a b c` spans its extra words and must decline. */
  singleWord: boolean
}

/**
 * Depth-first walk collecting every file_redirect with the context the tee
 * transform needs. A redirected_statement's own redirects keep the pipeline
 * enclosing the statement; its children reset it (inner lists/pipelines have
 * their own scope).
 */
function collectRedirects(
  node: Node,
  nested: boolean,
  pipeline: Node | null,
  owner: Node | null,
  out: CollectedRedirect[],
): void {
  const ownerHere = node.type === 'redirected_statement' ? node : owner
  for (const child of node.children) {
    if (child.type !== 'file_redirect') continue
    const op = child.children.find(c => c.type === '>' || c.type === '>>')
    const words = child.children.filter(c => c.type === 'word')
    const fdChild = child.children.find(c => c.type === 'file_descriptor')
    out.push({
      node: child,
      parentType: node.type,
      owner: ownerHere,
      pipeline,
      nested,
      operator: op ? (op.type as '>' | '>>') : null,
      target: words[0]?.text ?? null,
      fd: fdChild ? Number(fdChild.text) : 1,
      singleWord: op !== undefined && words.length === 1,
    })
  }

  const childNested = nested || NESTED_CONTEXTS.has(node.type)
  for (const child of node.children) {
    if (child.type === 'file_redirect') continue
    let childPipeline = pipeline
    if (node.type === 'redirected_statement') childPipeline = null
    if (child.type === 'pipeline') childPipeline = child
    collectRedirects(child, childNested, childPipeline, ownerHere, out)
  }
}

/**
 * Heredoc handling for one owner statement:
 * - null  — no heredoc; the tee stage inserts at the owner's end.
 * - number — insert right after the heredoc's delimiter word, BEFORE the
 *   body (`cat <<'EOF' | tee f`), the only valid position. Never after the
 *   body: `EOF | tee f` is not a terminator line, bash swallows the rest of
 *   the command as heredoc body ("delimited by end-of-file") and tee never
 *   runs.
 * - false — malformed for the transform (two heredocs on one line parse as
 *   one node spanning only the first body): decline the whole statement.
 */
function heredocInsertion(owner: Node): number | false | null {
  const heredocs: Node[] = []
  const scan = (n: Node): void => {
    for (const child of n.children) {
      if (NESTED_CONTEXTS.has(child.type)) continue
      if (child.type === 'heredoc_redirect') heredocs.push(child)
      scan(child)
    }
  }
  scan(owner)
  if (heredocs.length === 0) return null
  if (heredocs.length > 1) return false
  const heredoc = heredocs[0]!
  // Fail closed on any child the transform does not model: a stacked
  // heredoc (`cat <<'A' <<'B'`) parses to one node whose stray second
  // heredoc lands as an ERROR child — tee-ing there would attach the second
  // heredoc to the tee stage and silently redirect its body.
  const knownChildren = new Set([
    '<<',
    '<<-',
    'heredoc_start',
    'heredoc_body',
    'heredoc_end',
    'file_redirect',
  ])
  if (heredoc.children.some(c => !knownChildren.has(c.type))) return false
  const starts = heredoc.children.filter(c => c.type === 'heredoc_start')
  if (starts.length !== 1) return false
  return starts[0]!.endIndex
}

/**
 * Rewrite fd1 `>`/`>>` redirects into `| tee [-a] <target>` dual-write
 * stages: the model's target genuinely receives the write, and tee's
 * passthrough flows to the stdio fd exec() already opened on the harness
 * capture file — the human keeps the uncapped stream. Only positions a
 * pipeline can express are tee'd; every other redirect (fd≥2, nested in a
 * substitution/subshell, mid-pipeline, pre-redirect, extra-word or non-literal
 * targets, stacked heredocs) is passed through unchanged — that stream is not
 * captured, and the tool result footer says so. Permission analysis has
 * already run on the original command by this point; nothing re-parses the
 * rewritten text.
 *
 * The pipeline's exit is safe because the exec prefix chain always sets
 * `set -o pipefail` (findSuitableShell only ever returns bash/zsh).
 * Returns null when the command has no `>`/`>>` file redirects at all — the
 * caller then execs it unchanged.
 */
export function rewriteRedirectsForDualWrite(
  command: string,
): OutputCaptureRewrite | null {
  if (!hasRewritableRedirectSyntax(command)) return null

  const root = parseCommandRaw(command)
  if (!root) return null

  const collected: CollectedRedirect[] = []
  collectRedirects(root, false, null, null, collected)
  if (collected.length === 0) return null

  // Group by owner: one statement with several fd1 redirects cannot tee
  // correctly (bash applies only the last, a tee chain duplicates into
  // both), so all-or-none per statement.
  const byOwner = new Map<Node, CollectedRedirect[]>()
  for (const entry of collected) {
    if (!entry.owner) continue
    const list = byOwner.get(entry.owner)
    if (list) list.push(entry)
    else byOwner.set(entry.owner, [entry])
  }

  type Splice = {
    kind: 'insert' | 'remove'
    offset: number
    text?: string
    end?: number
  }
  const splices: Splice[] = []
  const modeByEntry = new Map<CollectedRedirect, RedirectOutcome['mode']>()

  for (const [owner, entries] of byOwner) {
    // fd≥2 and malformed fd1 redirects always pass through.
    const fd1 = entries.filter(
      e =>
        e.operator !== null &&
        e.fd === 1 &&
        e.parentType !== 'command' &&
        !e.nested,
    )
    // Computed once: `false` means the statement's heredocs are malformed
    // for the transform, `null` means no heredoc (insert at the owner's end),
    // a number is the offset right after the heredoc's delimiter word.
    const heredoc = heredocInsertion(owner)
    let teeEntry: CollectedRedirect | null = null
    if (fd1.length === 1) {
      const candidate = fd1[0]!
      // A pipeline stage only carries fd1, and only the final stage may tee:
      // `a > f | b` must keep starving `b`, not feed it via tee.
      const { pipeline } = candidate
      const pipeFollows =
        pipeline !== null &&
        pipeline.children.some(
          c => c.type === '|' && c.startIndex >= owner.endIndex,
        )
      if (
        candidate.singleWord &&
        candidate.target !== null &&
        SAFE_TARGET.test(candidate.target) &&
        heredoc !== false &&
        !pipeFollows
      ) {
        teeEntry = candidate
      }
    }

    for (const entry of entries) {
      modeByEntry.set(entry, entry === teeEntry ? 'tee' : 'passthrough')
      if (entry !== teeEntry) continue
      // Insertion: after the heredoc delimiter when the owner carries one,
      // else at the owner statement's end (covers trailing redirects hoisted
      // onto lists/compounds: `a && b > f` → `a && b | tee f`).
      const insertAt = typeof heredoc === 'number' ? heredoc : owner.endIndex
      const bytes = Buffer.from(command, 'utf8')
      // Swallow one preceding space/tab so `cmd > f` → `cmd | tee f`, not
      // `cmd  | tee f`.
      let removeStart = entry.node.startIndex
      if (
        removeStart > 0 &&
        (bytes[removeStart - 1] === 0x20 || bytes[removeStart - 1] === 0x09)
      ) {
        removeStart--
      }
      splices.push({
        kind: 'remove',
        offset: removeStart,
        end: entry.node.endIndex,
      })
      splices.push({
        kind: 'insert',
        offset: insertAt,
        text: ` | tee${entry.operator === '>>' ? ' -a' : ''} ${entry.target}`,
      })
    }
  }

  // Ascending single pass over the original buffer: at equal offsets an
  // insertion lands before a removal starting there (`cat <<'EOF' > f` —
  // tee goes after the delimiter, the ` > f` bytes follow and are removed).
  splices.sort((a, b) =>
    a.offset !== b.offset ? a.offset - b.offset : a.kind === 'insert' ? -1 : 1,
  )
  const bytes = Buffer.from(command, 'utf8')
  const parts: Buffer[] = []
  let pos = 0
  for (const s of splices) {
    parts.push(bytes.subarray(pos, s.offset))
    if (s.kind === 'insert') {
      parts.push(Buffer.from(s.text!, 'utf8'))
      pos = s.offset
    } else {
      pos = s.end!
    }
  }
  parts.push(bytes.subarray(pos))

  // Command order: the walk can visit a trailing redirect before an
  // earlier nested one, so order by source offset. Only redirects the
  // transform understood (plain `>`/`>>` with a literal word target) are
  // itemized — `&>`, `>&`-merges and quoted/expanded targets stay in the
  // command text unreported, exactly as today's decline left them.
  const targets: RedirectOutcome[] = collected
    .filter(e => e.operator !== null && e.target !== null)
    .sort((a, b) => a.node.startIndex - b.node.startIndex)
    .map(entry => ({
      target: entry.target!,
      operator: entry.operator!,
      mode: modeByEntry.get(entry) ?? 'passthrough',
    }))
  if (targets.length === 0) return null

  const taskId = generateTaskId('local_bash')
  return {
    rewrittenCommand: Buffer.concat(parts).toString('utf8'),
    harnessPath: getTaskOutputPath(taskId),
    taskId,
    targets,
  }
}

// --- Trailing tail/head stage strip -----------------------------------------

/** One stripped trailing stage: the model's requested inline window/filter. */
export type OutputLimiterStage =
  | {
      tool: 'tail' | 'head'
      /** Line count; both tools default to 10 when the model wrote no count. */
      lines: number
    }
  | {
      tool: 'grep'
      /** Pattern exactly as the shell would hand it to grep (unquoted, with
       * POSIX classes already translated to JS-compatible source). */
      pattern: string
      /** -F: fixed string; otherwise -E extended regex. */
      fixed: boolean
      ignoreCase: boolean
      invert: boolean
    }

export type OutputLimiterStrip = {
  /** Command with every strippable trailing stage removed. */
  strippedCommand: string
  /** The stripped stages in pipeline order — the delivery window to honor. */
  stages: OutputLimiterStage[]
  /** The model's line was a command LIST (`a; b | tail`, `a && b | head`):
   * the stripped window/filter covers the COMBINED capture of every
   * statement, not just the last pipeline — the footer must say so. */
  listCommand: boolean
}

// Strict trailing-stage forms: `tail`/`head` with a literal line count
// (`-8`, `-n 8`, `-n8`) or none (both default to 10 lines). Anything else —
// `-f`/`-F` (follow), `-c` (bytes), `+N` (from-line), file operands, extra
// flags, a stage carrying its own redirect — either changes semantics or
// bounds delivery in ways the stripped execution would not reproduce, and is
// left to execute exactly as written.
const TAIL_STAGE = /^tail(?:\s+(?:-n\s*(\d+)|-(\d+)))?$/
const HEAD_STAGE = /^head(?:\s+(?:-n\s*(\d+)|-(\d+)))?$/

// Strict trailing `grep` stage: optional flag tokens from {E, F, i, v}
// (combined `-iE` or separate `-i -E`), then exactly ONE pattern operand.
// Exactly one of -E/-F must appear — a bare pattern is BRE, whose escaping
// rules a JS RegExp cannot reproduce faithfully (silent alternation
// mismatches), so it declines and executes as written. Pattern operand
// forms: 'single-quoted' (content literal — inside single quotes a
// backslash is literal too), "double-quoted" (no $, backtick or backslash —
// expansion/escapes are ambiguous, decline rather than guess), or bare (no
// whitespace, quotes or shell metacharacters).
const GREP_STAGE =
  /^grep(?<flags>(?:\s+-[EFiv]+)*)\s+(?<pattern>'[^']*'|"[^\\$`"]*"|[^\s'"|<>&;$()\\]+)$/

/** POSIX bracket classes → JS-compatible class bodies. Unknown classes are
 * left verbatim and the pattern declines: `[[:foo:]]` does NOT make a JS
 * RegExp throw — it silently becomes a different character class. */
const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  xdigit: '0-9A-Fa-f',
  word: '\\w',
  punct: '!-/:-@\\[-`{-~',
  cntrl: '\\x00-\\x1f\\x7f',
  graph: '\\x21-\\x7e',
  print: '\\x20-\\x7e',
}

/** Translate `[[:class:]]` to `[JS-class]`; unknown classes stay verbatim
 * (the caller declines on any survivor). */
function translatePosixClasses(pattern: string): string {
  return pattern.replace(/\[\[:([a-z]+):\]\]/g, (match, name: string) =>
    POSIX_CLASSES[name] !== undefined ? `[${POSIX_CLASSES[name]}]` : match,
  )
}

/** Parse a strict trailing grep stage to a filter descriptor, or null when
 * the form is not strict (caller lets it execute as written). Validation
 * happens at STRIP time on purpose: constructing the JS RegExp here
 * guarantees the delivery-time application can never throw. */
function tryParseGrepStage(
  stageText: string,
): Extract<OutputLimiterStage, { tool: 'grep' }> | null {
  const match = GREP_STAGE.exec(stageText)
  if (match?.groups === undefined) return null
  const flagChars = new Set(match.groups.flags!.replace(/[\s-]/g, ''))
  // Exactly one matcher flavor; -E -F together declines (real grep lets
  // the later one win — not worth emulating).
  if (Number(flagChars.has('E')) + Number(flagChars.has('F')) !== 1) return null

  const operand = match.groups.pattern!
  const bare = !operand.startsWith("'") && !operand.startsWith('"')
  const pattern = bare ? operand : operand.slice(1, -1)

  if (flagChars.has('F')) {
    return {
      tool: 'grep',
      pattern,
      fixed: true,
      ignoreCase: flagChars.has('i'),
      invert: flagChars.has('v'),
    }
  }
  const translated = translatePosixClasses(pattern)
  // Surviving POSIX classes, collating elements, or lookaround syntax
  // diverge between ERE and JS silently — never strip those.
  if (/\[\[:|\[\[[.=]|\(\?/.test(translated)) return null
  try {
    new RegExp(translated)
  } catch {
    return null
  }
  return {
    tool: 'grep',
    pattern: translated,
    fixed: false,
    ignoreCase: flagChars.has('i'),
    invert: flagChars.has('v'),
  }
}

/**
 * Strip one trailing `| tail …` / `| head …` stage: returns the command
 * without it, or null when the last pipeline stage is not a strict
 * tail/head form. Uses the rightmost pipe's BYTE offset (tree-sitter
 * offsets are UTF-8 bytes; a string slice would land mid-token after
 * multi-byte characters) — a pipe inside a command substitution can be the
 * rightmost pipe, but then the trailing text carries the closing `)` and
 * fails the strict form, so nested pipes decline naturally.
 */
function tryStripOneStage(
  command: string,
): { stripped: string; stage: OutputLimiterStage } | null {
  const root = parseCommandRaw(command)
  if (!root) return null
  const parsed = buildParsedCommandFromRoot(command, root)
  const lastPipe = parsed.getLastPipePosition()
  if (lastPipe === null) return null

  const bytes = Buffer.from(command, 'utf8')
  const stageText = bytes
    .subarray(lastPipe + 1)
    .toString('utf8')
    .trim()
  const tailMatch = TAIL_STAGE.exec(stageText)
  const headMatch = HEAD_STAGE.exec(stageText)
  const grepStage = tailMatch || headMatch ? null : tryParseGrepStage(stageText)
  if (!tailMatch && !headMatch && grepStage === null) return null

  const stripped = bytes.subarray(0, lastPipe).toString('utf8').trimEnd()
  if (stripped === '') return null
  if (grepStage !== null) return { stripped, stage: grepStage }
  // Both tools default to 10 lines when the model wrote no count; the two
  // capture groups cover `-n N` and `-N`.
  const count = (tailMatch ?? headMatch)!
  const lines = Number(count[1] ?? count[2] ?? 10)
  return {
    stripped,
    stage: {
      tool: tailMatch ? 'tail' : 'head',
      lines,
    },
  }
}

/**
 * Pre-training habit: models end commands with `| tail`/`| head` to cap
 * their own context, and `| grep …` to pre-filter for signal lines.
 * Executing those stages would truncate the stream BEFORE the harness
 * captures it — the user's live output view reads the same file the capture
 * writes — so every STRICT trailing stage is stripped and the complete
 * stream captured instead. The stripped stages ride the result and
 * TaskOutput applies them to the capture file at delivery, so the model
 * still receives exactly the lines it asked for (inline under the limit,
 * else preview + file path + exit code). Chains (`cmd | grep -E x | tail
 * -20`) strip one stage per iteration and are reported in pipeline order.
 * Returns null when nothing was strippable — the caller execs unchanged.
 */
/** Whether the command's top level is a LIST of statements (`a; b`,
 * `a && b`) rather than a single command/pipeline — a trailing stage then
 * windows/filters every statement's COMBINED output at delivery. Nested
 * lists (inside a subshell or substitution) do not count: `(a; b) | tail`
 * pipes exactly what the model grouped, so no disclosure is needed. */
function isCommandList(command: string): boolean {
  const root = parseCommandRaw(command)
  if (!root) return false
  const statements = root.children.filter(
    c => c.type === 'command' || c.type === 'pipeline' || c.type === 'list',
  )
  return statements.length > 1 || statements.some(c => c.type === 'list')
}

export function stripTrailingOutputLimiters(
  command: string,
): OutputLimiterStrip | null {
  let current = command
  const strippedStages: OutputLimiterStage[] = []
  // Each iteration removes the rightmost pipe, so the loop terminates.
  while (true) {
    const next = tryStripOneStage(current)
    if (next === null) break
    current = next.stripped
    strippedStages.push(next.stage)
  }
  if (strippedStages.length === 0) return null
  // Stripped rightmost-first; pipeline order is the reverse.
  return {
    strippedCommand: current,
    stages: strippedStages.reverse(),
    listCommand: isCommandList(command),
  }
}

/** Apply one grep stage as a line filter. The pattern was validated at
 * strip time, so the RegExp construction cannot throw here. */
function filterLinesByGrep(
  lines: string[],
  stage: Extract<OutputLimiterStage, { tool: 'grep' }>,
): string[] {
  const match = (line: string): boolean => {
    if (stage.fixed) {
      return stage.ignoreCase
        ? line.toLowerCase().includes(stage.pattern.toLowerCase())
        : line.includes(stage.pattern)
    }
    return new RegExp(stage.pattern, stage.ignoreCase ? 'i' : '').test(line)
  }
  return lines.filter(line => match(line) !== stage.invert)
}

/**
 * Apply stripped tail/head/grep stages to captured text, in pipeline
 * order: `tail -20 | head -5` yields the first 5 of the last 20 lines,
 * `grep -E err | tail -5` the last 5 matching lines. A trailing newline is
 * preserved as real tail/head would print one. When the result exceeds
 * maxChars, the cap preserves the model's intent — a tail-most window keeps
 * its END (the lines it asked for), anything else keeps its start.
 */
export function applyLimiterStages(
  text: string,
  stages: readonly OutputLimiterStage[],
  maxChars: number,
): string {
  if (stages.length === 0) return text
  const hadTrailingNewline = text.endsWith('\n')
  const body = hadTrailingNewline ? text.slice(0, -1) : text
  let lines = body === '' ? [] : body.split('\n')
  for (const stage of stages) {
    if (stage.tool === 'grep') {
      lines = filterLinesByGrep(lines, stage)
    } else {
      lines =
        stage.tool === 'tail'
          ? lines.slice(-stage.lines)
          : lines.slice(0, stage.lines)
    }
  }
  let out = lines.join('\n')
  if (hadTrailingNewline && out !== '') out += '\n'
  if (out.length > maxChars) {
    const lastStage = stages[stages.length - 1]!
    out =
      lastStage.tool === 'tail' ? out.slice(-maxChars) : out.slice(0, maxChars)
  }
  return out
}

// PowerShell file redirection: plain `>`/`>>` (no fd digit) followed by a
// bare literal path. Anything quoted, parenthesized (subexpression), or
// variable-laden is declined — same fail-closed rule as the POSIX rewrite.
const PS_REDIRECT_TARGET = /(\d*>>?)\s+([A-Za-z0-9._/@^%+=:,~()[\]#-]+)/g

/**
 * PowerShell variant of the dual-write rewrite: plain `>`/`>>` file targets
 * become `| Tee-Object [-Append] -FilePath <target>` stages, so the target
 * receives the write and the passthrough still flows to the stdio capture.
 * fd-digit forms (`2>`) have no pipeline equivalent and pass through
 * unchanged; `2>&1` carries no path and never matches. A `|` between the
 * match and the next statement boundary (`;`, newline, end) means the
 * redirect is not at pipeline end (`cmd > f | next` would feed `next`
 * through Tee-Object) and passes through too.
 *
 * Exit codes: the pwsh provider's trailing `$_ec` prefers `$LASTEXITCODE`,
 * so a native command's failure still propagates through the Tee-Object
 * pipeline; a failing cmdlet sets `$?` false ⇒ exit 1.
 */
export function rewritePsRedirectsForDualWrite(
  command: string,
): OutputCaptureRewrite | null {
  if (!command.includes('>')) return null
  const taskId = generateTaskId('local_bash')
  const harnessPath = getTaskOutputPath(taskId)
  const targets: RedirectOutcome[] = []
  const rewritten = command.replace(
    PS_REDIRECT_TARGET,
    (match, opGroup: string, target: string, offset: number) => {
      const parts = /^(\d*)(>>?)$/.exec(opGroup)
      if (!parts) return match
      const fdDigits = parts[1]!
      const op = parts[2] as '>' | '>>'
      const passthrough = (): string => {
        targets.push({ target, operator: op, mode: 'passthrough' })
        return match
      }
      if (fdDigits !== '') return passthrough()
      const rest = command.slice(offset + match.length)
      const boundary = rest.search(/[;\n]/)
      const statementTail = boundary === -1 ? rest : rest.slice(0, boundary)
      if (statementTail.includes('|')) return passthrough()
      targets.push({ target, operator: op, mode: 'tee' })
      return `| Tee-Object${op === '>>' ? ' -Append' : ''} -FilePath ${target}`
    },
  )
  if (targets.length === 0) return null
  return { rewrittenCommand: rewritten, harnessPath, taskId, targets }
}
