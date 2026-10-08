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
        '- Foreground (default): blocks until the command finishes and returns its output. Use for a one-shot command whose result you need before doing anything else. For a long-running command you would otherwise wait on, use background instead and rely on the system notification — never sleep in the foreground to wait for a result.',
        '- Background (`run_in_background: true`): returns immediately with a task ID and an output file path; the command keeps running and a system task notification reports its completion — no waiting or polling on your side. Never follow a launch with `sleep`/`tail` of the output file, and never read it while the command is still running; if you have nothing else to do, end your turn — the notification arrives automatically at a later turn boundary, and that is when you read the output. Read the output file early only to diagnose a failure. Use for a long-running command whose result you need but cannot act on meanwhile, or to overlap a one-shot command with other work.',
        '- Open-ended watches are not a Bash run mode: to react to output while it is still arriving (tailing a log, polling a CI job, waiting for a file to change), use the Monitor tool instead — it runs the command detached and surfaces changed output as task notifications. Never emulate a watch by putting `sleep` in a Bash command, foreground or background: the background notification arrives on its own at a later turn boundary and sleeping first does not make it arrive sooner.',
      ].join('\n')
    : 'Executes a shell command. The bash tool blocks and returns once the command finishes, with its output.'

  const paragraphs: Array<string> = [
    patterns,
    'Never append `| tail`, `| head`, `| wc -l`, or `| grep -c` to a command to cap or shrink its output — the harness caps output for you in every mode: foreground results over the limit are saved to a file automatically and the path is returned to you; background and monitor commands stream their full output to the task output file, and monitor notifications carry only the new lines. Piping to cap output is therefore useless AND destructive — it discards rows you may need, and it truncates what the user can see in the UI. Filter only to select semantically relevant rows (a targeted `rg` match is fine), never to reduce volume.',
    'In `rg` (ripgrep), `-r` means `--replace`, not recursive — rg is recursive by default. The grep habit `rg -rn PATTERN` sets the replacement string to `n`, silently overwriting every match in the output with a literal `n`; use `rg -n PATTERN`.',
  ]

  return paragraphs.join('\n\n')
}
