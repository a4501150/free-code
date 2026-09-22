import { sendDaemonControl } from './daemonControl.js'

/**
 * The TUI entry to the machine's assistant session. The assistant lives in the
 * webui gateway (which lives in the daemon), so joining it means making sure
 * that stack is up, then finding the child's live attach descriptor.
 */

export type JoinedAssistant = {
  pid: number
  sessionId: string
}

const BOOTSTRAP_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500

async function currentWebStatus() {
  const response = await sendDaemonControl({ kind: 'web.status' })
  return response && response.ok ? response.status : null
}

/**
 * Ensures the gateway (and with it the assistant) is running, then waits for
 * the assistant child to report a live attach descriptor. Runs the `web
 * start` flow — first-run password setup included — when no gateway answers.
 * Returns null when the assistant never appears (opt-out, or a gateway that
 * cannot host it).
 */
export async function ensureAssistantSession(): Promise<JoinedAssistant | null> {
  let status = await currentWebStatus()
  if (!status?.running) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      'No web gateway running — starting it (this also starts the assistant)...',
    )
    const { webMain } = await import('./cli.js')
    await webMain(['start'])
    status = await currentWebStatus()
  }
  if (!status?.running) return null

  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const assistant = status?.assistant
    if (assistant?.live) {
      return { pid: assistant.pid, sessionId: assistant.sessionId }
    }
    await Bun.sleep(POLL_INTERVAL_MS)
    status = await currentWebStatus()
  }
  return status?.assistant?.live
    ? {
        pid: status.assistant.pid,
        sessionId: status.assistant.sessionId,
      }
    : null
}
