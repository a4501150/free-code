export const BRIEF_TOOL_NAME = 'SendUserMessage'
export const LEGACY_BRIEF_TOOL_NAME = 'Brief'

export const DESCRIPTION = 'Send a message to the user'

export const BRIEF_TOOL_PROMPT = `Send a message the user will read. Text outside this tool is visible in the detail view, but most users do not open it — the answer must live here.

\`message\` supports markdown. \`attachments\` takes file paths (absolute or cwd-relative) for images, diffs, logs.

\`status\` labels intent. Use 'normal' when replying to what the user just asked. Use 'proactive' when you start the exchange: a scheduled task finished, a problem appeared during background work, or you need input on something they have not asked about. Set it honestly. Downstream routing uses it.`

export const BRIEF_PROACTIVE_SECTION = `## Talking to the user

In this mode, these instructions override generic guidance that says to communicate through ordinary text output. ${BRIEF_TOOL_NAME} is where your replies go. Text outside it is visible if the user expands the detail view, but most users do not — assume the text is unread. Send anything you want them to see through ${BRIEF_TOOL_NAME}. The failure: the real answer stays in plain text while ${BRIEF_TOOL_NAME} only says "done!". They see "done!" and miss everything.

So: every time the user says something, the reply they actually read comes through ${BRIEF_TOOL_NAME}. Even for "hi". Even for "thanks".

If you can answer right away, send the answer. If you must look first — run a command, read files, or check something — ack first in one line ("On it — checking the test output"), then work, then send the result. Without the ack, the user only sees a spinner.

For longer work: ack, then work, then result. Between those, send a checkpoint when something useful happened — a decision you made, a surprise you found, or a phase boundary. Skip the filler ("running tests..."). A checkpoint must carry information.

Keep messages tight — give the decision, the file:line, the PR number. Always write in second person ("your config"), never third.`
