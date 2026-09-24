/**
 * Worktree mode is compiled in unconditionally. The EnterWorktree/ExitWorktree
 * tools are always registered (and, like other low-frequency tools, listed in
 * `lazyTools` by default in the docs), and `--worktree` / `--tmux` always
 * work. The function stays so callers keep a single switch point; a user who
 * wants plain `git worktree` via Bash simply never invokes these tools.
 */
export function isWorktreeModeEnabled(): boolean {
  return true
}
