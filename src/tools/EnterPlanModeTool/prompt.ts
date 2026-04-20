import { isPlanModeInterviewPhaseEnabled } from '../../utils/planModeV2.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

const WHAT_HAPPENS_SECTION = `## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

`

function getEnterPlanModeToolPromptExternal(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

Prefer using EnterPlanMode for implementation tasks with multiple valid approaches, unclear requirements, architectural choices, or multi-file changes; skip it for simple fixes, single-function additions with clear requirements. If you would use ${ASK_USER_QUESTION_TOOL_NAME} to clarify the approach, use EnterPlanMode and then use the ${ASK_USER_QUESTION_TOOL_NAME} to get clarification.

${whatHappens}## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
`
}

function getEnterPlanModeToolPromptAnt(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `Use this tool when a task has genuine ambiguity about the right approach and getting user input before coding would prevent significant rework. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

Plan mode is valuable when the implementation approach is genuinely unclear. Use it when:

1. **Significant Architectural Ambiguity**: Multiple reasonable approaches exist and the choice meaningfully affects the codebase
   - Example: "Add caching to the API" - Redis vs in-memory vs file-based
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling

2. **Unclear Requirements**: You need to explore and clarify before you can make progress
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Refactor this module" - need to understand what the target architecture should be

3. **High-Impact Restructuring**: The task will significantly restructure existing code and getting buy-in first reduces risk
   - Example: "Redesign the authentication system"
   - Example: "Migrate from one state management approach to another"

## When NOT to Use This Tool

Skip plan mode when you can reasonably infer the right approach:
- The task is straightforward even if it touches multiple files
- The user's request is specific enough that the implementation path is clear
- You're adding a feature with an obvious implementation pattern (e.g., adding a button, a new endpoint following existing conventions)
- Bug fixes where the fix is clear once you understand the bug
- Research/exploration tasks (use the Agent tool instead)
- The user says something like "can we work on X" or "let's do X" — just get started

When in doubt, prefer starting work and using ${ASK_USER_QUESTION_TOOL_NAME} for specific questions over entering a full planning phase.

${whatHappens}## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
`
}

export function getEnterPlanModeToolPrompt(): string {
  return getEnterPlanModeToolPromptExternal()
}
