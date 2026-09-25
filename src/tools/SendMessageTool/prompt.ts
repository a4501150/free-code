export const DESCRIPTION = 'Send a message to another agent or session'

export function getPrompt(): string {
  return `
# SendMessage

Send a message to another agent or session.

\`\`\`json
{"to": "researcher", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"agent-a1b"\` or a registered agent name | A subagent you spawned with the Agent tool. Running agents get the message at their next tool round; stopped or finished agents are resumed from their transcript. |
| \`"session:<id>"\` | Another live session, delivered to it as a prompt turn. Discover targets (and their IDs) with ListAgents. |

Your plain text output is NOT visible to other agents. To communicate, you MUST call this tool. Messages from workers arrive automatically as notifications; you do not need to check an inbox. Refer to agents by name or ID, never by UUID. When you relay a message, do not quote the original. The original is already shown to the user.
`.trim()
}
