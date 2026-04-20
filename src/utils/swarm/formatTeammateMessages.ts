/**
 * Pure leaf: format teammate messages as XML for attachment display.
 *
 * Extracted from teammateMailbox.ts so messages.ts can depend on this without
 * pulling in the mailbox's teammate/attachment-related transitive graph.
 */

import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js'

export function formatTeammateMessages(
  messages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }>,
): string {
  return messages
    .map(m => {
      const colorAttr = m.color ? ` color="${m.color}"` : ''
      const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
      return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`
    })
    .join('\n\n')
}
