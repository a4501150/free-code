/**
 * Shared registration slots for pane backends.
 *
 * This leaf exists to break the import cycle between `registry.ts` (which
 * detects and constructs backends) and the concrete backend modules
 * (`TmuxBackend.ts`, `ITermBackend.ts`) which self-register their class at
 * module-init time. Before, the backend modules imported `registerXBackend`
 * directly from `registry.ts`, forcing `registry.ts` to be partially evaluated
 * before the backends could wire themselves in — and also meant that any
 * static import of the backend modules from `registry.ts` would create a
 * genuine cycle.
 *
 * By holding the class slots here, `registry.ts` can statically import the
 * concrete backend modules to trigger their registration, and the backend
 * modules no longer need to know anything about `registry.ts`.
 */

import type { PaneBackend } from './types.js'

let TmuxBackendClass: (new () => PaneBackend) | null = null
let ITermBackendClass: (new () => PaneBackend) | null = null

/**
 * Registers the TmuxBackend class. Called by TmuxBackend.ts at module init.
 */
export function registerTmuxBackend(
  backendClass: new () => PaneBackend,
): void {
  TmuxBackendClass = backendClass
}

/**
 * Registers the ITermBackend class. Called by ITermBackend.ts at module init.
 */
export function registerITermBackend(
  backendClass: new () => PaneBackend,
): void {
  ITermBackendClass = backendClass
}

/**
 * Returns the registered TmuxBackend class, or null if it has not yet
 * self-registered. The registry is expected to ensure the backend module has
 * been loaded before calling.
 */
export function getTmuxBackendClass(): (new () => PaneBackend) | null {
  return TmuxBackendClass
}

/**
 * Returns the registered ITermBackend class, or null if it has not yet
 * self-registered.
 */
export function getITermBackendClass(): (new () => PaneBackend) | null {
  return ITermBackendClass
}
