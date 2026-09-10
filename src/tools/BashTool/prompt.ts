import { prependBullets } from '../../constants/prompts.js'
import { shouldPreferBashForSearch } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return 'Use `run_in_background: true` to start a long-running command without holding the turn open. It returns at once with a task ID and an output file path, and a completion notification arrives on its own. To wait on external state, fold the polling into one backgrounded loop with an exit condition: `while ! check; do sleep 5; done`.'
}

export function getSimplePrompt(): string {
  // When Glob/Grep are stripped from the registry, we don't steer away from
  // find/grep in Bash.
  const embedded = shouldPreferBashForSearch()

  const backgroundNote = getBackgroundUsageNote()

  const instructionItems: Array<string | string[]> = [
    'The user reads every tool result in the session, and output is auto-saved to a file (referenced in the result) when it grows — run the command bare: a pipe through `tail`, `head`, or `grep` truncates what the user gets to see.',
    'Never prepend `cd <current-directory>` to a `git` command — `git` already operates on the current working tree, and the compound triggers a permission prompt.',
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  return [
    'Executes a given bash command and returns its output. The working directory persists between commands, but shell state does not.',
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    ...(backgroundNote ? ['', backgroundNote] : []),
  ].join('\n')
}
