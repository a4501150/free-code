export function getEnterWorktreeToolPrompt(): string {
  return `Use this tool ONLY when the user explicitly asks to work in a worktree — the user must literally say "worktree" (for example, "start a worktree", "work in a worktree"). This tool creates an isolated git worktree and switches the current session into it.

Do not use it for branches or normal feature/bug work — use normal git workflow unless the user specifically mentions worktrees. Must be in a git repository (or have WorktreeCreate/WorktreeRemove hooks configured) and not already be in a worktree. In a git repository it creates a new worktree inside \`.freecode/worktrees/\` with a new branch based on HEAD; outside one it delegates to the hooks for VCS-agnostic isolation. Use ExitWorktree to leave mid-session (keep or remove); on session exit, if still in the worktree, the user will be prompted to keep or remove it.
`
}
