export const LIST_AGENTS_TOOL_NAME = 'ListAgents'

export const DESCRIPTION = `Lists messaging targets you can address with SendMessage: spawned subagents in this process (agent ID or name, status — a finished one can be resumed with a follow-up message) and other live sessions on this machine (session ID, kind, pid — address one with to:"session:<id>").
Use this before messaging a peer you did not spawn yourself.`
