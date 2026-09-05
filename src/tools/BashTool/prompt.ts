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
  return "If you're about to use `sleep` or a polling loop, use `run_in_background: true` instead. The tool returns immediately with a task ID and a file path that streams the command's stdout/stderr (Read the file as it accumulates, or use BackgroundTaskOutput to retrieve task status and output). When the command exits, a <task-notification> system message arrives as soon as possible — between tool rounds if a turn is active, or when idle. The notification only fires when the bash command exits — sleeping or polling on your end does not change when it arrives. For polling external state via bash, wrap the polling in a single backgrounded bash loop with a clear exit condition (e.g. `while ! check; do sleep 5; done`). If you need to background commands that never terminate (so the notification never fires) — for example, `tail -f`, dev servers, long-running watchers — inspect output as needed and stop the task via BackgroundTaskStop when it's no longer needed."
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
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.',
    `You may specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes). By default, your command will timeout after ${getDefaultTimeoutMs()}ms (${getDefaultTimeoutMs() / 60000} minutes).`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'When a command streams progress — `gh run watch`, a build, a test run, anything backgrounded — run it bare, with no pipe. A filter that must read to EOF (`tail`, `sort`, `wc`) holds every line until the command exits. Piping also makes many programs switch from line buffering to block buffering. Either way the output file stays empty while the command runs, so the user watching the task sees a blank progress row until it ends. The full output lands in that file anyway, so filtering it gains you nothing.',
    "Do not use `| tail`, `| head`, `--limit`-style flags, or any other technique to shrink a command's output. The tool already caps inline output and persists the full result to a file whose path comes back with the result, so there is no context-length cost for large output. Read the persisted file with Read or BackgroundTaskOutput instead. Truncating inside the command throws the rest away for the user too.",
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
    ...(gitInstructions ? ['', gitInstructions] : []),
  ].join('\n')
}
