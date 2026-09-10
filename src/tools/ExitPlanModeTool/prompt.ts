// External stub for ExitPlanModeTool prompt

// Hardcoded to avoid relative import issues in stub
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const EXIT_PLAN_MODE_TOOL_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- The plan must already be written to the plan file specified in the plan mode system message; this tool takes no plan content and reads it from that file
- The user cannot see the plan until this tool is called, so resolve open questions with ${ASK_USER_QUESTION_TOOL_NAME} first, then call this tool

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you are gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.
`
