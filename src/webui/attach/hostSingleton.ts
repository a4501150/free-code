import {
  getSessionId,
  getTotalCostUSD,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  onSessionSwitch,
} from '../../bootstrap/state.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { startAttachHost, type AttachHost } from './attachHost.js'
import type { AttachRuntime } from './runtime.js'

let host: AttachHost | null = null
let pendingRuntime: AttachRuntime | null = null

/**
 * The process's attach host, or null when the WebUI is compiled out, the
 * platform is unsupported, or this process does not own a top-level session.
 */
export function getAttachHost(): AttachHost | null {
  return host
}

/**
 * Registers the process's runtime.
 *
 * The REPL mounts before `registerSession()` resolves, so the runtime is
 * routinely offered before the host exists. Holding it here means neither side
 * has to know about the other's startup order.
 */
export function registerAttachRuntime(runtime: AttachRuntime): void {
  pendingRuntime = runtime
  host?.registerRuntime(runtime)
}

export function publishAttachTranscript(): void {
  host?.publishTranscript()
}

export function publishAttachMeta(): void {
  host?.publishMeta()
}

export function publishAttachTodos(): void {
  host?.publishTodos()
}

/**
 * Starts the attach host for this process.
 *
 * Called after `registerSession()` succeeds, so a subagent or a `doctor`
 * subcommand never publishes a socket. Startup does not await the listener.
 */
export function startProcessAttachHost(options: {
  cwd: string
  entrypoint?: string
}): AttachHost | null {
  if (host) return host

  host = startAttachHost({
    sessionId: getSessionId(),
    cwd: options.cwd,
    entrypoint: options.entrypoint,
    getCost: () => ({
      costUsd: getTotalCostUSD(),
      linesAdded: getTotalLinesAdded(),
      linesRemoved: getTotalLinesRemoved(),
    }),
  })

  if (!host) return null
  const started = host

  if (pendingRuntime) started.registerRuntime(pendingRuntime)

  // /resume and /clear both change the session under a live process. The socket
  // stays put; only the identity on it moves.
  onSessionSwitch(id => {
    started.setSessionId(id)
  })

  registerCleanup(async () => {
    started.stop()
  })

  return started
}

/** Test seam. Production code never replaces a running host. */
export function resetProcessAttachHostForTests(): void {
  host?.stop()
  host = null
  pendingRuntime = null
}
