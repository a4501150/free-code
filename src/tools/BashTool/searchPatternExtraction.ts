import { parseForSecurity } from '../../utils/bash/ast.js'

/**
 * Display-only heuristic: pull the human-meaningful search pattern out of a
 * Bash search command so the collapsed read/search row can show
 * `Searched memories for "pattern"` instead of the raw command line.
 *
 * Deliberately conservative — every unclear case returns undefined and the
 * caller falls back to showing the raw command, which is always honest.
 * A wrong guess here only mislabels a dim summary row; it never gates
 * permissions or execution.
 */

// Commands whose first positional (or -e value) is the pattern. `which` and
// `whereis` are collapsible searches but their positional is a program name,
// not a pattern, so they are excluded and keep the raw-command hint.
const PATTERN_POSITION_COMMANDS = new Set(['grep', 'rg', 'ag', 'ack', 'locate'])

// find predicates whose VALUE is the search pattern.
const FIND_PATTERN_PREDICATES = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-regex',
  '-lname',
  '-ilname',
  '-wholename',
  '-iwholename',
])

// Flags in grep/rg/ag/ack that consume the NEXT argv token as their value.
// The list covers the flags that plausibly appear in an agent-issued search
// command; a missing entry can only shift the picked token, and the
// first-positional scan still skips anything flag-shaped.
const VALUE_FLAGS = new Set([
  '-A',
  '-B',
  '-C',
  '-M',
  '-f',
  '-g',
  '-m',
  '-r',
  '-j',
  '--color',
  '--after-context',
  '--before-context',
  '--context',
  '--context-separator',
  '--file',
  '--max-count',
  '--include',
  '--exclude',
  '--exclude-from',
  '--exclude-dir',
  '--glob',
  '--iglob',
  '--replace',
  '--threads',
  '--colors',
  '--ignore-file',
  '--pre',
  '--pre-glob',
  '--sort',
  '--engine',
  '--max-columns',
])

// Flags with an attached numeric value: `grep -m1 pat`, `rg -C3 pat`.
const ATTACHED_VALUE_FLAG = /^-[ABCFMefjm]\d+$/

/**
 * For grep/rg/ag/ack/locate: `-e PATTERN` wins when present (subsequent
 * positionals are then file paths, not the pattern); otherwise the first
 * non-flag argument. Ambiguity (conflicting -e values, nothing left after
 * flag skipping) returns undefined.
 */
function positionalPattern(argv: string[]): string | undefined {
  let ePattern: string | undefined
  let positional: string | undefined
  let endOfFlags = false

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (!endOfFlags && (arg === '-e' || arg === '--regexp')) {
      const value = argv[i + 1]
      if (value === undefined) return undefined
      if (ePattern !== undefined && ePattern !== value) return undefined
      ePattern = value
      i++
      continue
    }
    if (!endOfFlags && arg.startsWith('-') && arg !== '-') {
      if (arg === '--') {
        endOfFlags = true
        continue
      }
      // Skip the flag's value too so it can't be picked as the pattern.
      if (VALUE_FLAGS.has(arg) || ATTACHED_VALUE_FLAG.test(arg)) {
        if (!ATTACHED_VALUE_FLAG.test(arg)) i++
        continue
      }
      continue
    }
    if (positional === undefined) {
      positional = arg
    }
  }

  return ePattern ?? positional
}

/**
 * For find: the value of the first recognised pattern predicate. Multiple
 * different pattern values are ambiguous.
 */
function findPredicatePattern(argv: string[]): string | undefined {
  let pattern: string | undefined
  for (let i = 1; i < argv.length; i++) {
    if (FIND_PATTERN_PREDICATES.has(argv[i]!)) {
      const value = argv[i + 1]
      if (value === undefined) return undefined
      if (pattern !== undefined && pattern !== value) return undefined
      pattern = value
      i++
    }
  }
  return pattern
}

/**
 * Extract the search pattern from a (possibly compound) bash command.
 * Returns undefined when no pattern can be identified: unparseable input,
 * no recognised search command, a search command with no extractable
 * pattern, or multiple search segments with different patterns.
 */
export function extractBashSearchPattern(command: string): string | undefined {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple') return undefined

  let pattern: string | undefined
  for (const cmd of parsed.commands) {
    const prog = cmd.argv[0]
    if (!prog) continue
    const candidate =
      prog === 'find'
        ? findPredicatePattern(cmd.argv)
        : PATTERN_POSITION_COMMANDS.has(prog)
          ? positionalPattern(cmd.argv)
          : undefined
    if (candidate === undefined) {
      // A search command we couldn't read a pattern from makes the whole
      // command un-labelable — show the raw line.
      if (prog === 'find' || PATTERN_POSITION_COMMANDS.has(prog)) {
        return undefined
      }
      continue
    }
    if (candidate === '') return undefined
    if (pattern !== undefined && pattern !== candidate) return undefined
    pattern = candidate
  }
  return pattern
}
