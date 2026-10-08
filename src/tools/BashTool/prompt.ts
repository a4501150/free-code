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
        "- Monitor (`monitor_notify_freq: \"90s\"`): for an open-ended watch that should react to output while it is still running — tailing a log, polling a CI job, waiting for a file to change. The command runs detached and keeps running; new output is surfaced as a system task notification at a turn boundary, not streamed mid-turn. The value is the MAXIMUM notification cadence, not a timer — a notification fires only when the latest output line differs from the last notified line, and at most once per interval; identical consecutive lines never notify. The harness enforces the cadence itself: never implement it inside the command with `sleep` (no `sleep 90; check`, no loop whose sleep matches the interval) — poll world state at whatever rate gives timely detection, run the first check immediately at t=0, and print only when the verdict changes; repeated identical lines cost nothing. At t=0, verify you locked onto the right target: if it is missing, already in the expected terminal state, or a different entity than you meant (say, the latest run of the wrong workflow), print that finding and exit immediately instead of watching silently. An exit that prints nothing is a failed monitor — every exit path (verdict reached, wrong or already-terminal target at t=0, deadline expired) must print exactly one short line stating the outcome. Every notification costs a full agent turn: wrap the command so it prints only verdicts and errors — never raw build/compile output (bazel, webpack, gradle). End by a hard deadline. When a monitor's notification arrives, quote its verdict line in your reply — the verdict reaches the conversation only through you, and the user should not have to open the task panel to learn the outcome. Poll authoritative world state for an exact match instead of watching one object's lifetime or grepping a loose prefix, and capture `rc=$?` before any pipe, because `cmd | tail; echo $?` reports tail's status, not the command's. Check status on demand with BackgroundTaskList or by reading the output file; stop a monitor with BackgroundTaskStop.",
      ].join('\n')
    : 'Executes a shell command. The bash tool blocks and returns once the command finishes, with its output.'

  const paragraphs: Array<string> = [
    patterns,
    'Never append `| tail`, `| head`, `| wc -l`, or `| grep -c` to a command to cap or shrink its output — the harness caps output for you in every mode: foreground results over the limit are saved to a file automatically and the path is returned to you; background and monitor commands stream their full output to the task output file, and monitor notifications carry only the new lines. Piping to cap output is therefore useless AND destructive — it discards rows you may need, and it truncates what the user can see in the UI. Filter only to select semantically relevant rows (a targeted `rg` match is fine), never to reduce volume.',
    'In `rg` (ripgrep), `-r` means `--replace`, not recursive — rg is recursive by default. The grep habit `rg -rn PATTERN` sets the replacement string to `n`, silently overwriting every match in the output with a literal `n`; use `rg -n PATTERN`.',
  ]

  return paragraphs.join('\n\n')
}
