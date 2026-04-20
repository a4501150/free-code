import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import { renderMessagesToPlainText } from '../utils/exportRenderer.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import {
  getLogByIndex,
  loadMessageLogs,
} from '../utils/sessionStorage.js'
import { validateUuid } from '../utils/uuid.js'
import type { LogOption } from '../types/logs.js'
import type { Message } from '../types/message.js'

/**
 * `claude export <source> <outputFile>`
 *
 * Renders a conversation log to plain text.
 *
 * `<source>` can be:
 *   - a session UUID
 *   - a numeric log index (0 = most recent)
 *   - a filesystem path to a `.json` or `.jsonl` transcript file
 */
export async function exportHandler(
  source: string,
  outputFile: string,
): Promise<void> {
  let logOption: LogOption | null = null

  const maybeSessionId = validateUuid(source)
  if (maybeSessionId) {
    const logs = await loadMessageLogs()
    logOption =
      logs.find(l => l.sessionId === maybeSessionId || l.leafUuid === maybeSessionId) ?? null
    if (!logOption) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`No conversation found with session ID: ${source}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  } else if (/^\d+$/.test(source)) {
    const index = Number(source)
    logOption = await getLogByIndex(index)
    if (!logOption) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`No conversation found at index ${index}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  } else {
    // Treat as a filesystem path to a .json/.jsonl log file
    const resolved = resolve(source)
    try {
      // Just verify file exists; loadConversationForResume handles reading.
      await readFile(resolved)
    } catch (e) {
      if (isENOENT(e)) {
        // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
        console.error(`File not found: ${resolved}`)
      } else {
        // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
        console.error(
          `Unable to read ${resolved}: ${errorMessage(e)}`,
        )
      }
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }

    try {
      const result = await loadConversationForResume(undefined, resolved)
      if (!result) {
        // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
        console.error(`Unable to parse ${resolved} as a Claude transcript`)
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      }
      await writeRenderedMessages(result.messages, outputFile)
      return
    } catch (e) {
      logError(e)
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`Failed to render ${resolved}: ${errorMessage(e)}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  if (!logOption) {
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  try {
    const result = await loadConversationForResume(logOption, undefined)
    if (!result) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`Failed to load conversation for: ${source}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    await writeRenderedMessages(result.messages, outputFile)
  } catch (e) {
    logError(e)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to export ${source}: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}

async function writeRenderedMessages(
  messages: Message[],
  outputFile: string,
): Promise<void> {
  const text = await renderMessagesToPlainText(messages)
  const outPath = resolve(outputFile)
  await writeFile(outPath, text, { encoding: 'utf-8' })
  // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
  console.log(outPath)
}
