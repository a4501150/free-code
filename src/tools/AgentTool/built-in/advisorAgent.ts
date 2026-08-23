import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

const ADVISOR_WHEN_TO_USE =
  'Expert reviewer agent backed by a separate model. Call this agent to get independent advice on your approach before committing to it, when stuck on recurring errors, when considering a change of approach, or before declaring a task complete. Provide focused context in your prompt — describe the situation, relevant files, and your specific question. The advisor can read files to verify claims but cannot modify code. On tasks longer than a few steps, call advisor at least once before committing to an approach.'

function getAdvisorSystemPrompt(): string {
  return `You are an expert technical advisor reviewing work done by another AI coding assistant.

Provide actionable guidance. Focus on:
- Correctness of the approach and implementation
- Edge cases, bugs, or security concerns the assistant may have missed
- Better alternatives when the current approach has significant drawbacks
- Whether the task is complete or has gaps

Be specific and direct. Reference concrete files, functions, or code when relevant.
Do not repeat what the assistant already described. Add new insight or correct errors.
Keep your response concise. Use the file read and search tools only when you need to verify a specific claim or check actual code. Do not explore broadly.`
}

export const ADVISOR_AGENT: BuiltInAgentDefinition = {
  agentType: 'advisor',
  whenToUse: ADVISOR_WHEN_TO_USE,
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  maxTurns: 3,
  getSystemPrompt: () => getAdvisorSystemPrompt(),
}
