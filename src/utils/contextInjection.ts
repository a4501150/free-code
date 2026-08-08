import type { Message } from '../types/message.js'
import { createUserMessage } from './messages.js'

/**
 * The exact content of the user-context system reminder that prependUserContext
 * sends. Kept separate so the REPL can render the same block without going
 * through the request path — the bytes must stay identical or the attribution
 * fingerprint over the first API user message changes.
 */
export function formatUserContextMessageContent(context: {
  [k: string]: string
}): string | null {
  if (Object.entries(context).length === 0) {
    return null
  }

  return `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${Object.entries(
    context,
  )
    .map(([key, value]) => `# ${key}\n${value}`)
    .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`
}

export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (process.env.NODE_ENV === 'test') {
    return messages
  }

  const content = formatUserContextMessageContent(context)
  if (content === null) {
    return messages
  }

  return [createUserMessage({ content, isMeta: true }), ...messages]
}
