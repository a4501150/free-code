export const DESCRIPTION = 'Send a message to another agent'

export function getPrompt(): string {
  return `
# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates — the cost grows with the team size, so use it only when everyone truly needs the message |

Your plain text output is NOT visible to other agents. To communicate, you MUST call this tool. Messages from teammates arrive automatically; you do not need to check an inbox. Refer to teammates by name, never by UUID. When you relay a message, do not quote the original. The original is already shown to the user.

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with this tool using the matching \`_response\` type. Echo the \`request_id\` and set \`approve\` to true or false. Approving shutdown ends your process. Rejecting a plan sends the teammate back to revise. Do not send \`shutdown_request\` unless the user asks. Do not send structured JSON status messages. Use TaskUpdate instead.
`.trim()
}
