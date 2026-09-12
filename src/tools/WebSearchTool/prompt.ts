import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Searches the web and uses the results to inform your response; results arrive as search result blocks containing title/URL pairs
- Use for information beyond your knowledge cutoff; searches run within a single API call

CRITICAL REQUIREMENT: End your response with a "Sources:" section listing the relevant result URLs as markdown hyperlinks: [Title](URL). Never skip it.

Usage notes:
  - IMPORTANT: If an MCP-provided web search tool is available, prefer using that tool instead of this one, because it can have fewer restrictions.
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US
  - Use the current year (${currentMonthYear}) in queries for recent information, NOT last year
`
}
