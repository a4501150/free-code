export const DESCRIPTION = 'Send a message to another agent or session'

export function getPrompt(): string {
  return `Send a message to another agent or session. Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool.

A stopped or finished subagent is resumed from its transcript when messaged; discover targets (and their IDs) with ListAgents. Messages from workers arrive automatically as notifications; you do not need to check an inbox. Refer to agents by name or ID, never by UUID. When you relay a message, do not quote the original — it is already shown to the user.`
}
