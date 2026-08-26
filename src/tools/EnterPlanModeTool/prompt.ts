import { shouldPreferBashForSearch } from '../../utils/embeddedTools.js'
import { isPlanModeInterviewPhaseEnabled } from '../../utils/planMode.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

function getWhatHappensSection(): string {
  const searchTools = shouldPreferBashForSearch()
    ? '`find`, `grep`, and Read'
    : 'Glob, Grep, and Read'

  return `## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using ${searchTools}
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

`
}

function getEnterPlanModeToolPromptExternal(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : getWhatHappensSection()

  return `Use this tool when the user asks you to plan, or when requirements are genuinely ambiguous and need clarification before any code can be written. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

Skip plan mode for simple fixes, single-function additions, clear requirements, or tasks where the approach is obvious. If you would use ${ASK_USER_QUESTION_TOOL_NAME} to clarify the approach, use EnterPlanMode and then use the ${ASK_USER_QUESTION_TOOL_NAME} to get clarification.

${whatHappens}## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
`
}

export function getEnterPlanModeToolPrompt(): string {
  return getEnterPlanModeToolPromptExternal()
}
