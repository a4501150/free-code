import { readFile } from 'fs/promises'
import { formatRelativeTimeAgo } from '../utils/format.js'
import { errorMessage } from '../utils/errors.js'
import { getErrorLogByIndex, loadErrorLogs, logError } from '../utils/log.js'

/**
 * `claude error [n]`
 *
 * - With no arg: lists recent persisted error logs.
 * - With a numeric arg: displays the error log at that index (0 = most recent).
 *
 * Error-log persistence is controlled by the `errorLogSink` setting in
 * freecode.json (default: false). When enabled, errors are written to
 * `~/.claude/errors/`.
 */
export async function errorHandler(n: number | undefined): Promise<void> {
  if (n === undefined) {
    const logs = await loadErrorLogs()
    if (logs.length === 0) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.log(
        'No error logs found.\n' +
          'Enable persistent error logging by setting `errorLogSink: true` in freecode.json.',
      )
      return
    }
    for (const log of logs) {
      const age = formatRelativeTimeAgo(log.modified)
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.log(`[${log.value}] ${age} · ${log.fullPath ?? ''}`)
    }
    return
  }

  const log = await getErrorLogByIndex(n)
  if (!log) {
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`No error log at index ${n}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  try {
    const content = log.fullPath
      ? await readFile(log.fullPath, { encoding: 'utf-8' })
      : ''
    process.stdout.write(content)
  } catch (e) {
    logError(e)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to read error log: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}
