export const LIST_AGENTS_TOOL_NAME = 'ListAgents'

export const DESCRIPTION = `
- Lists messaging targets you can address with SendMessage
- In this process: spawned subagents (agent ID or name, status) — a finished one can be resumed with a follow-up message
- On this machine: other live sessions (session ID, kind, pid) — address one with to:"session:<id>"
- Use this before messaging a peer you did not spawn yourself
`
