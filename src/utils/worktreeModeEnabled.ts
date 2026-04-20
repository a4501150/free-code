import { feature } from 'bun:bundle'

/**
 * Gated behind the `WORKTREE_MODE` feature flag. When off, the
 * EnterWorktree/ExitWorktree tools are stripped from the registry and
 * the `--worktree` / `--tmux` CLI flags are disabled; vanilla
 * `git worktree add/remove` via the Bash tool covers the same ground.
 */
export function isWorktreeModeEnabled(): boolean {
  if (feature('WORKTREE_MODE')) return true
  return false
}
