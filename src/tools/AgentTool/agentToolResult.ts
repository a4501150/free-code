import type { AgentToolResult } from './agentToolSchemas.js'

export function withAgentStoppedStatus(
  result: Pick<AgentToolResult, 'content' | 'errorReason'>,
): AgentToolResult['content'] {
  if (!result.errorReason) return result.content
  return [
    {
      type: 'text' as const,
      text: `<status>stopped: ${result.errorReason}</status>`,
    },
    ...result.content,
  ]
}
