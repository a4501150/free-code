import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `A search tool built on ripgrep.

  - Full ripgrep regex syntax (for example, "log.*Error", "function\\s+\\w+"). Literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code).
  - Results are permission-managed and consistently formatted, which raw \`grep\`/\`rg\` via ${BASH_TOOL_NAME} is not.
`
}
