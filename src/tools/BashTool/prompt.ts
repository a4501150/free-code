import { isBackgroundTasksEnabled } from '../../utils/backgroundTasks.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
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
  // The -regex quirk below is a bfs (embedded search sidecar) behavior; on a
  // system find it does not apply, so gate on the sidecars being available.
  const embedded = hasEmbeddedSearchTools()

  const paragraphs: Array<string> = [
    'Executes a shell command.',
    isBackgroundTasksEnabled()
      ? [
          'When running a command in the foreground, the bash tool blocks and returns once the command finishes, with its output.',
          'When running a command in the background, the bash tool returns immediately with a task ID and an output file path. The command keeps running until it exits or a terminating code or signal is caught, and you will receive a system task notification reporting its status and its output file path.',
          '',
          "You don't have to do anything while waiting for a backgrounded command: once it completes, a system task notification is delivered automatically by the harness.",
        ].join('\n')
      : 'The bash tool blocks and returns once the command finishes, with its output.',
    'Do not append `| tail`, `| head`, or `| grep` to a command to cap the output. The user watches bash tool results in the UI, and a pipe truncates what the user can see. Large output needs no cap from you: the output is saved to a file automatically and the path will be returned to you.',
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form skips `.tsx` files without an error.",
        ]
      : []),
  ]

  return ['# Instructions', ...paragraphs].join('\n\n')
}
