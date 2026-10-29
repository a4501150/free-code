import { isBackgroundTasksEnabled } from '../../utils/backgroundTasks.js'
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

// The patterns below and the `run_in_background` param share one gate: under
// the backgroundTasksEnabled: false setting the param is removed from the
// schema (BashTool.tsx), the Monitor tool is disabled, and the prompt keeps
// only the foreground pattern, so the two never disagree about what exists.

export function getSimplePrompt(): string {
  const patterns: string = isBackgroundTasksEnabled()
    ? [
        'Executes a shell command. Pick the run mode by need:',
        '- Foreground (default): blocks until the command finishes and returns its output; use it only for a one-shot command whose result you need before doing anything else.',
        '- Background (`run_in_background: true`): returns immediately with a task ID and an output file path; a system task notification reports completion with the exit status — use it for any long-running command.',
        '- To react to output while it is still arriving (tailing a log, polling a CI job), use the Monitor tool instead.',
      ].join('\n')
    : 'Executes a shell command. The bash tool blocks and returns once the command finishes, with its output.'

  const paragraphs: Array<string> = [
    patterns,
    'Never `sleep` in a Bash command to wait for a result — the background task notification arrives on its own; end your turn and read the output file when it lands.',
    'Never cap or capture output yourself with `| tail`, `| head`, `| wc -l`, or a `> out.log 2>&1` redirect (with or without an `echo "EXIT=$?"` tail) — the harness already saves the command\'s full output to a file and gives you the path, and reports the exit status: read that file instead of making your own, since piping or redirecting only destroys rows you and the user may need.',
    'In `rg` (ripgrep), `-r` means `--replace`, not recursive (rg is recursive by default): the grep habit `rg -rn PATTERN` silently overwrites every match with a literal `n`; use `rg -n PATTERN`.',
  ]

  return paragraphs.join('\n\n')
}
