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

// The three patterns below and the `run_in_background`/`monitor_notify_freq`
// params share one gate: under the backgroundTasksEnabled: false setting the
// params are removed from the schema (BashTool.tsx) and the prompt keeps only
// the foreground pattern, so the two never disagree about what exists.

export function getSimplePrompt(): string {
  const patterns: string = isBackgroundTasksEnabled()
    ? [
        'Executes a shell command. Pick the run mode by need:',
        '- Foreground (default): blocks until the command finishes and returns its output. Use for a one-shot command whose result you need before doing anything else. For a long-running command you would otherwise wait on, use background instead and rely on the system notification — never sleep in the foreground to wait for a result.',
        '- Background (`run_in_background: true`): returns immediately with a task ID and an output file path; the command keeps running and a system task notification reports its completion — no waiting or polling on your side. Never follow a launch with `sleep`/`tail` of the output file, and never read it while the command is still running; if you have nothing else to do, end your turn — the notification arrives automatically at a later turn boundary, and that is when you read the output. Read the output file early only to diagnose a failure. Use for a long-running command whose result you need but cannot act on meanwhile, or to overlap a one-shot command with other work.',
        "- Monitor (`monitor_notify_freq: \"90s\"`): for an open-ended watch that should react to output while it is still running — tailing a log, polling a CI job, waiting for a file to change. The command runs detached and keeps running; new output is surfaced as a system task notification at a turn boundary, not streamed mid-turn. The value is the MAXIMUM notification cadence, not a timer — a notification fires only when the latest output line differs from the last notified line, and at most once per interval; identical consecutive lines never notify. Every notification costs a full agent turn: wrap the command so it prints only on completion, failure, or error — never raw build/compile output (bazel, webpack, gradle). A monitor must fail fast — validate its target and expected value at t=0 — and end by a hard deadline with an explicit verdict on every exit path, since a monitor that cannot fail or cannot end delivers no notification. Poll authoritative world state for an exact match instead of watching one object's lifetime or grepping a loose prefix, and capture `rc=$?` before any pipe, because `cmd | tail; echo $?` reports tail's status, not the command's. Check status on demand with BackgroundTaskList or by reading the output file; stop a monitor with BackgroundTaskStop.",
      ].join('\n')
    : 'Executes a shell command. The bash tool blocks and returns once the command finishes, with its output.'

  const paragraphs: Array<string> = [
    patterns,
    'Do not append `| tail`, `| head`, or `| grep` to a command to cap the output — the output is already capped for you: over the limit it is saved to a file automatically and the path will be returned to you. The user watches bash tool results in the UI, and a pipe truncates what the user can see.',
    'In `rg` (ripgrep), `-r` means `--replace`, not recursive — rg is recursive by default. The grep habit `rg -rn PATTERN` sets the replacement string to `n`, silently overwriting every match in the output with a literal `n`; use `rg -n PATTERN`.',
  ]

  return paragraphs.join('\n\n')
}
