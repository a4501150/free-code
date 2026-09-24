import { prependBullets } from '../../constants/prompts.js'
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

// The availability of `run_in_background` is signalled on its schema
// description (BashTool.tsx), which is removed from the schema together with
// the param under the backgroundTasksEnabled: false setting — so the sleep
// cluster below stays accurate either way: with backgrounding unavailable,
// there is simply never a notification to wait for.

export function getSimplePrompt(): string {
  // The -regex quirk below is a bfs (embedded search sidecar) behavior; on a
  // system find it does not apply, so gate on the sidecars being available.
  const embedded = hasEmbeddedSearchTools()

  const instructionItems: Array<string | string[]> = [
    'Run the command without a pipe. Do not append `| tail`, `| head`, or `| grep` to cap the output. The user watches your tool results in the UI, and a pipe truncates what the user sees. Large output needs no cap from you: it is saved to a file and the result names the path.',
    'A trailing pipe on a long-running command does worse than truncate: the pipe buffers ALL output until the command exits, so a watcher, dev server, or `tail -f` piped into anything streams nothing and dies on the timeout. Run monitoring commands unpiped.',
    'Make commands and scripts print something. A silent run leaves the user with nothing to watch, and a failing script that never says where it stopped is hard to debug. For long-running work, prefer progress output (verbose flags, per-step echoes). Do not suppress output to save tokens: large output is stored in a file, not pasted into the context.',
    'Avoid unnecessary `sleep` — it never makes a notification arrive sooner. A backgrounded command keeps running across turns and re-invokes you with a completion notification when it exits; sleeping or polling on your end does not change when it lands, and chained foreground sleeps cost a turn each. Do not sleep-and-poll to check progress: a backgrounded command that finishes on its own already ends in that notification. For a wait that will not finish on its own (external state, another process), run a monitor command or script that creates the exit signal by exiting once the condition holds (e.g. `until <check>; do sleep 2; done`, backgrounded when the wait may be long) — its notification carries the exit status and the output file path.',
    'Do not prepend `cd <current-directory> &&` to a `git` command — you are already there, and the compound needs a permission rule for both parts. To work in another directory, `cd` there first (the working directory persists) or run `git -C <dir>`.',
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

  return [
    'Executes a given bash command and returns its output. The working directory persists between commands, but shell state does not.',
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
  ].join('\n')
}
