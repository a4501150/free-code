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

// Background-task guidance lives on the `run_in_background` schema description
// (BashTool.tsx), which is removed from the schema together with the param
// under the backgroundTasksEnabled: false setting — no prompt-side gating needed.

export function getSimplePrompt(): string {
  // The -regex quirk below is a bfs (embedded search sidecar) behavior; on a
  // system find it does not apply, so gate on the sidecars being available,
  // not on Glob/Grep being stripped.
  const embedded = hasEmbeddedSearchTools()

  const instructionItems: Array<string | string[]> = [
    'Run the command without a pipe. Do not append `| tail`, `| head`, or `| grep` to cap the output. The user reads every tool result, and a pipe truncates what the user sees. Large output needs no cap from you: it is saved to a file and the result names the path.',
    'A trailing pipe on a long-running command does worse than truncate: the pipe buffers ALL output until the command exits, so a watcher, dev server, or `tail -f` piped into anything streams nothing and dies on the timeout. Run monitoring commands unpiped.',
    'Make commands and scripts print something. A silent run leaves the user with nothing to watch, and a failing script that never says where it stopped is hard to debug. For long-running work, prefer progress output (verbose flags, per-step echoes). Do not suppress output to save tokens: large output is stored in a file, not pasted into the context.',
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
