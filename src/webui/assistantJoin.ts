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

/** The short probe timeout every other `web.status` call site uses. */
async function currentWebStatus() {
  const response = await sendDaemonControl({ kind: 'web.status' }, 2_000)
  return response && response.ok ? response.status : null
}

/**
 * Ensures the gateway (and with it the assistant) is running, then waits for
 * the assistant child to report a live attach descriptor. Runs the `web
 * start` flow — first-run password setup included — when no gateway answers.
 * Returns null when the assistant will not appear (`assistant.enabled: false`,
 * or a gateway that could not host it).
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
    if (assistant) {
      if (assistant.state === 'gone') return null
      if (assistant.state === 'live') {
        return { pid: assistant.pid, sessionId: assistant.sessionId }
      }
    }
    await Bun.sleep(POLL_INTERVAL_MS)
    status = await currentWebStatus()
  }
  return null
}
