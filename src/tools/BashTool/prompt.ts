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
        '- Foreground (default): blocks until the command finishes and returns its output. Use for a one-shot command whose result you need before doing anything else. For a long-running command you would otherwise wait on, use background instead and rely on the system notification — never sleep in the foreground to wait for a result, and do not inflate `timeout` to force one to fit the foreground.',
        '- Background (`run_in_background: true`): returns immediately with a task ID and an output file path; the command keeps running and a system task notification reports its completion with the exit status — no waiting or polling on your side. Once launched, do not run `sleep`, `tail`, or any other wait-then-read: your sleep does not schedule the notification, which arrives on its own at a later turn boundary — end your turn if you have nothing else to do, and read the output when the notification lands. Read the output file early only to diagnose a failure. Run the command bare: the harness captures its full output to the task output file and the user watches it arrive live in the UI; wrapping it in your own log redirect (`cmd > out.log 2>&1; echo "EXIT=$?"`) blanks that view, and the exit status you were echoing is reported to you anyway. Use background mode for any long-running command — test suites, builds, deployments — not only when you need the result yourself: backgrounding is also what makes the progress visible to the user.',
        '- Open-ended watches are not a Bash run mode: to react to output while it is still arriving (tailing a log, polling a CI job, waiting for a file to change), use the Monitor tool instead — it runs the command detached and surfaces changed output as task notifications. Never emulate a watch by putting `sleep` in a Bash command, foreground or background: the background notification arrives on its own at a later turn boundary and sleeping first does not make it arrive sooner.',
      ].join('\n')
    : 'Executes a shell command. The bash tool blocks and returns once the command finishes, with its output.'

  const paragraphs: Array<string> = [
    patterns,
    'Never append tail or head for bash command when running test',
    "Never append `| tail`, `| head`, `| wc -l`, or `| grep -c` to a command to cap or shrink its output — the harness caps output for you already: foreground results over the limit are saved to a file automatically and the path is returned to you; background and monitor commands stream their full output to the task output file, and monitor notifications carry only the new lines. Piping to cap output is therefore useless AND destructive — it discards rows you may need, and it truncates what the user can see in the UI. Filter only to select semantically relevant rows (a targeted `rg` match is fine), never to reduce volume. The same applies to a private log redirect (`> out.log 2>&1`): the harness already keeps the command's full output in a file for you — redirecting it yourself only moves it out of your and the user's sight.",
    "In a multi-step command, join a step to the one it depends on with `&&` (or begin the script with `set -e`), never with `;` or a newline: after `make serve; until curl -sf $URL; do sleep 5; done` fails to start the server, the loop still polls for minutes and the failure surfaces late, under the wrong cause. A wait or poll loop must also end when its producer dies: check the producer's exit status before the loop and its liveness inside it — by PID (`kill -0 $pid`) or service state (`systemctl is-active $unit`) — and exit nonzero with one line that names the failure. Never test liveness with `pgrep -f` or `ps | grep` on text that also appears in your own command line: the pattern matches the checking shell itself, so the check stays true after the target exits.",
    'In `rg` (ripgrep), `-r` means `--replace`, not recursive — rg is recursive by default. The grep habit `rg -rn PATTERN` sets the replacement string to `n`, silently overwriting every match in the output with a literal `n`; use `rg -n PATTERN`.',
  ]

  return paragraphs.join('\n\n')
}
