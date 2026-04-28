import { formatRelativeTimeAgo } from '../utils/format.js'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import { renderMessagesToPlainText } from '../utils/exportRenderer.js'
import { errorMessage } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getLogByIndex, loadMessageLogs } from '../utils/sessionStorage.js'
import { validateUuid } from '../utils/uuid.js'
import type { LogOption } from '../types/logs.js'

/**
 * `claude log [number|sessionId]`
 *
 * - With no arg: lists the most recent message logs by index.
 * - With a numeric arg: renders the log at that index to stdout.
 * - With a UUID arg: renders the log with that session ID to stdout.
 */
export async function logHandler(
  logId: string | number | undefined,
): Promise<void> {
  if (logId === undefined) {
    const logs = await loadMessageLogs(20)
    if (logs.length === 0) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.log('No conversation logs found')
      return
    }
    for (const log of logs) {
      const age = formatRelativeTimeAgo(log.modified)
      const title =
        log.summary && log.summary !== 'No prompt'
          ? log.summary
          : log.firstPrompt
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.log(`[${log.value}] ${age} · ${title}`)
    }
    return
  }

  let logOption: LogOption | null = null
  if (typeof logId === 'number' || /^\d+$/.test(String(logId))) {
    const index = typeof logId === 'number' ? logId : Number(logId)
    logOption = await getLogByIndex(index)
    if (!logOption) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`No conversation found at index ${index}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  } else {
    const sessionId = validateUuid(logId)
    if (!sessionId) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`Invalid log identifier: ${logId}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    const logs = await loadMessageLogs()
    logOption =
      logs.find(l => l.sessionId === sessionId || l.leafUuid === sessionId) ??
      null
    if (!logOption) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`No conversation found with session ID: ${logId}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  try {
    const result = await loadConversationForResume(logOption, undefined)
    if (!result) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`Failed to load conversation for: ${logId}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    const text = await renderMessagesToPlainText(result.messages)
    process.stdout.write(text)
  } catch (e) {
    logError(e)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to render log ${logId}: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}
