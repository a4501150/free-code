/**
 * The process's wire surface, started once after `registerSession()` resolves.
 *
 * Successor of `webui/attach/hostSingleton.ts`. The permission relay no longer
 * needs a bridge here: the surface mirrors the session request broker directly,
 * so a permission opened by the policy chain appears on the wire and is
 * answerable from any attached surface.
 */

import {
  getSessionId,
  getTotalCostUSD,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { startWireSurface, type WireSurface } from './surface.js'
import type { SessionRuntime } from './runtime.js'

let surface: WireSurface | null = null
let pendingRuntime: SessionRuntime | null = null

/**
 * The process's wire surface, or null when the WebUI is compiled out or this
 * process does not own a top-level session.
 */
export function getAttachSurface(): WireSurface | null {
  return surface
}

/**
 * Registers the process's runtime.
 *
 * The REPL mounts before `registerSession()` resolves, so the runtime is
 * routinely offered before the surface exists. Holding it here means neither
 * side has to know about the other's startup order.
 */
export function registerAttachRuntime(runtime: SessionRuntime): void {
  pendingRuntime = runtime
  surface?.registerRuntime(runtime)
}

export function publishAttachTranscript(): void {
  surface?.publishTranscript()
}

export function publishAttachMeta(): void {
  surface?.publishMeta()
}

export function publishAttachTodos(): void {
  surface?.publishTodos()
}

export function publishAttachTasks(): void {
  surface?.publishTasks()
}

export function publishAttachCatalog(): void {
  surface?.publishCatalog()
}

export function publishAttachPendingCommands(): void {
  surface?.publishQueue()
}

/**
 * Starts the wire surface for this process.
 *
 * Called after `registerSession()` succeeds, so a subagent or a `doctor`
 * subcommand never publishes a descriptor. Startup does not await the listener.
 */
export function startProcessAttachHost(options: {
  cwd: string
  entrypoint?: string
}): WireSurface | null {
  if (surface) return surface

  surface = startWireSurface({
    sessionId: getSessionId(),
    cwd: options.cwd,
    entrypoint: options.entrypoint,
    getCost: () => ({
      costUsd: getTotalCostUSD(),
      linesAdded: getTotalLinesAdded(),
      linesRemoved: getTotalLinesRemoved(),
    }),
  })

  if (!surface) return null
  const started = surface

  if (pendingRuntime) started.registerRuntime(pendingRuntime)

  // /resume and /clear both change the session under a live process. The
  // surface (and its descriptor path) stays put; only the identity on it moves.
  onSessionSwitch(id => {
    started.setSessionId(id)
  })

  registerCleanup(async () => {
    started.stop()
  })

  return started
}

/** Test seam. Production code never replaces a running surface. */
export function resetProcessAttachHostForTests(): void {
  surface?.stop()
  surface = null
  pendingRuntime = null
}
