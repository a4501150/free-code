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

// The background paragraphs below and the `run_in_background` param share one
// gate: under the backgroundTasksEnabled: false setting the param is removed
// from the schema (BashTool.tsx) and the prompt keeps only the foreground
// sentence, so the two never disagree about what exists.

export function getSimplePrompt(): string {
  const paragraphs: Array<string> = [
    'Executes a shell command.',
    isBackgroundTasksEnabled()
      ? [
          'When running a command in the foreground, the bash tool blocks and returns once the command finishes, with its output.',
          'When running a command in the background, the bash tool returns immediately with a task ID and an output file path. The command keeps running until it exits or a terminating code or signal is caught, and you will receive a system task notification reporting its status and its output file path — no waiting or polling on your side.',
          "A background command that monitors something (waiting on a job, poll, or deploy) must fail fast — validate its target and expected value at t=0 — and end by a hard deadline with an explicit verdict on every exit path, since a monitor that cannot fail or cannot end delivers no notification. Poll authoritative world state for an exact match instead of watching one object's lifetime or grepping a loose prefix, and capture `rc=$?` before any pipe, because `cmd | tail; echo $?` reports tail's status, not the command's.",
          'For an open-ended watch that should react to output while it is still running — tailing a log, polling a CI job, waiting for a file to change — use the Monitor tool instead of a background command or a blocking foreground call: it surfaces new output as it arrives at the next turn boundary, and only when it changes.',
        ].join('\n')
      : 'The bash tool blocks and returns once the command finishes, with its output.',
    'Do not append `| tail`, `| head`, or `| grep` to a command to cap the output. The user watches bash tool results in the UI, and a pipe truncates what the user can see. Large output needs no cap from you: the output is saved to a file automatically and the path will be returned to you.',
    'In `rg` (ripgrep), `-r` means `--replace`, not recursive — rg is recursive by default. The grep habit `rg -rn PATTERN` sets the replacement string to `n`, silently overwriting every match in the output with a literal `n`; use `rg -n PATTERN`.',
  ]

  return ['# Instructions', ...paragraphs].join('\n\n')
}
