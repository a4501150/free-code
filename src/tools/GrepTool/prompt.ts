import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `A powerful search tool built on ripgrep.

  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command.
  - Supports full ripgrep regex syntax (e.g., "log.*Error", "function\\s+\\w+"). Literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code).
  - Use the ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds.
`
}
