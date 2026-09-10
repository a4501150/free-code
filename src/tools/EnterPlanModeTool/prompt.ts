import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

function getEnterPlanModeToolPromptExternal(): string {
  return `Use this tool when the user asks you to plan, or when requirements are genuinely ambiguous and need clarification before any code can be written. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

Skip plan mode for simple fixes, single-function additions, clear requirements, or tasks where the approach is obvious. If you would use ${ASK_USER_QUESTION_TOOL_NAME} to clarify the approach, use EnterPlanMode and then use the ${ASK_USER_QUESTION_TOOL_NAME} to get clarification.

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If you are unsure whether to use it, choose planning - getting agreement before coding is better than redoing work
`
}

export function getEnterPlanModeToolPrompt(): string {
  return getEnterPlanModeToolPromptExternal()
}
