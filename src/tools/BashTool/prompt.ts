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
        '- Background (`run_in_background: true`): returns immediately with a task ID and an output file path; a system task notification reports completion with the exit status — use it for any long-running command (test suites, builds).',
        '- To react to output while it is still arriving (tailing a log, polling a CI job), use the Monitor tool instead.',
      ].join('\n')
    : 'Executes a shell command. The bash tool blocks and returns once the command finishes, with its output.'

  const paragraphs: Array<string> = [
    patterns,
    'Never `sleep` in a Bash command to wait for a result — the background task notification arrives on its own; end your turn and read the output file when it lands.',
    "Every result footer states `[exit N · full output: <path>]`: the command's COMPLETE output stream lives at that path. Your inline view is the first ~30k characters of that stream; over the cap you receive a preview plus the path — read the path when you need more.",
    'A trailing `| tail`/`| head` is honored without bounding the capture: the stage is stripped before execution and applied to your inline result — you receive exactly the lines you asked for — while the complete stream stays at the footer path.',
    'Your `>` / `>>` redirects are dual-written: the target file genuinely receives the write, and the same stream is also captured at the footer path. Redirect forms a pipeline cannot express — stderr targets (`2>`), inside `$(…)`, mid-pipeline — run exactly as written: the target gets the stream, the harness does not capture it, and the footer says so.',
    'In `rg` (ripgrep), `-r` means `--replace`, not recursive (rg is recursive by default): the grep habit `rg -rn PATTERN` silently overwrites every match with a literal `n`; use `rg -n PATTERN`.',
  ]

  return paragraphs.join('\n\n')
}
