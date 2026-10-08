export function getExitWorktreeToolPrompt(): string {
  return `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

This tool ONLY operates on worktrees created by EnterWorktree in this session — never worktrees created manually with \`git worktree add\` or in a previous session; called outside such a session it is a no-op and changes nothing. Do not call it proactively — only when the user asks. \`keep\` restores the original directory but leaves the worktree and branch on disk; \`remove\` also deletes them, and only send \`discard_changes: true\` after the user explicitly confirms destructive removal of uncommitted changes. If a tmux session was attached to the worktree: killed on \`remove\`, left running on \`keep\` (its name is returned so the user can reattach). Once exited, EnterWorktree can be called again to create a fresh worktree.
`
}
