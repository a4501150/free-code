import { prependBullets } from '../../constants/prompts.js'
import { shouldPreferBashForSearch } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import { getCommitAndPRInstructions } from '../shared/gitInstructions.js'

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
  return 'Use `run_in_background: true` instead of sleeping or polling. It returns at once with a task ID and an output file that streams while the command runs (see it with Read or BackgroundTaskOutput). A <task-notification> arrives the moment the command exits — nothing needs watching. To wait on external state, fold the polling into one backgrounded loop with an exit condition: `while ! check; do sleep 5; done`. Never pipe a backgrounded command: the filter buffers until the command exits, leaving the output file empty the whole run.'
}

const BASH_MULTILINE_SYNTAX = {
  commit: `a HEREDOC (\`git commit -m "$(cat <<'EOF' ... EOF\n)"\`)`,
  pr: 'a HEREDOC',
}

export function getSimplePrompt(): string {
  // When Glob/Grep are stripped from the registry, we don't steer away from
  // find/grep in Bash.
  const embedded = shouldPreferBashForSearch()

  const backgroundNote = getBackgroundUsageNote()

  const instructionItems: Array<string | string[]> = [
    'Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")',
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it. In particular, never prepend `cd <current-directory>` to a `git` command — `git` already operates on the current working tree, and the compound triggers a permission prompt.',
    `You may specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes). By default, your command will timeout after ${getDefaultTimeoutMs()}ms (${getDefaultTimeoutMs() / 60000} minutes).`,
    'Run commands bare — never pipe through `| tail`, `| grep`, `wc` or any other filter. Never a pipe to cap output: the tool caps inline output and persists the full result to the file path it returns, so Read that file instead. And on a streaming or backgrounded command the pipe also hides live progress, because the filter buffers until the command exits.',
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

  const gitInstructions = getCommitAndPRInstructions(BASH_MULTILINE_SYNTAX)

  return [
    'Executes a given bash command and returns its output. The working directory persists between commands, but shell state does not.',
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    ...(backgroundNote ? ['', backgroundNote] : []),
    ...(gitInstructions ? ['', gitInstructions] : []),
  ].join('\n')
}
