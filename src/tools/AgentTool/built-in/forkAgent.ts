import { isEnvTruthy } from '../../../utils/envUtils.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

// Gate mirrors the official CLAUDE_CODE_FORK_SUBAGENT env + settings source.
export function isForkAgentEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_FORK_SUBAGENT)
}

export function buildForkWorktreeNotice(
  parentCwd: string,
  worktreePath: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreePath} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}

// The directive wrapper. The fork inherits the parent's transcript, so the
// prompt is a directive (what to do), not a briefing (what the situation is).
export function buildForkDirective(
  prompt: string,
  worktreeNotice?: string,
): string {
  return `<fork>
You are a worker fork. The transcript above is the parent's history — inherited reference, not your situation. You are NOT a continuation of that agent. Execute ONE directive, then stop.

Hard rules:
- Do NOT spawn subagents with the ${AGENT_TOOL_NAME} tool. The "default to forking" guidance is for the parent; you ARE the fork, execute directly.
- One shot: report once and stop. No follow-up questions, no proposed next steps, no waiting for the user.

Guidelines (your directive may override any of these):
- Stay in scope. Other forks may be handling adjacent work; if you spot something outside your directive, note it in a sentence and move on.
- Open with one line restating your task, so the parent can spot scope drift at a glance.
- Be concise — as short as the answer allows, no shorter. Plain text, no preamble, no meta-commentary.
- If you committed changes, list the paths and commit hashes in your report.
</fork>

${worktreeNotice ? `${worktreeNotice}\n\n` : ''}${prompt}`
}

export const FORK_AGENT: BuiltInAgentDefinition = {
  agentType: 'fork',
  whenToUse:
    'Fork — inherits the parent\'s full conversation context and shares its prompt cache. Selected explicitly via subagent_type: "fork" when the fork gate is on; never the default. Use for work whose intermediate tool output is not worth keeping in the parent\'s context.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  background: true,
  getSystemPrompt: () => '',
}
