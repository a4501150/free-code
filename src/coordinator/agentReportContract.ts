import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'

/**
 * The one wording for how delegated-agent results reach an orchestrating
 * session. The coordinator system prompt and the assistant_mode attachment
 * both interpolate this constant so a stacked assistant+coordinator (and any
 * future orchestrator prompt) never learns two phrasings of the same rule.
 */
export const AGENT_REPORT_CONTRACT = `Delegated agent results arrive as user-role messages containing \`<task-notification>\` XML. The \`<task-id>\` is the agent's address — ${SEND_MESSAGE_TOOL_NAME} with that ID as \`to\` continues it. Until a notification arrives you know nothing about the agent's outcome: never fabricate or predict a pending agent's results; if asked, say it is still running.`
