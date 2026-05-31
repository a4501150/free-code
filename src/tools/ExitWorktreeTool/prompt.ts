export function getExitWorktreeToolPrompt(): string {
  return `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees you created manually with \`git worktree add\`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

## Behavior

- \`keep\` restores the original directory but leaves the worktree and branch on disk.
- \`remove\` restores the original directory and deletes the worktree and branch.
- If \`remove\` finds uncommitted files or unmerged commits, it refuses and lists them unless \`discard_changes: true\` is provided.
- Only send \`discard_changes: true\` after the user explicitly confirms destructive removal of those changes.
- Clears CWD-dependent caches (system prompt sections, memory files, plans directory) so the session state reflects the original directory.
- If a tmux session was attached to the worktree: killed on \`remove\`, left running on \`keep\` (its name is returned so the user can reattach).
- Once exited, EnterWorktree can be called again to create a fresh worktree.
`
}
