/**
 * Write-once registry for coordinator-managed worker agent definitions.
 *
 * This leaf lets `builtInAgents.ts` retrieve coordinator agents without a
 * static import of `workerAgent.ts` (which would close a cycle through
 * AgentTool). `workerAgent.ts` registers its provider at module init;
 * `builtInAgents.ts` reads via `getCoordinatorAgents()`.
 */

import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'

type Provider = () => AgentDefinition[]

let provider: Provider = () => []

export function registerCoordinatorAgents(p: Provider): void {
  provider = p
}

export function getCoordinatorAgents(): AgentDefinition[] {
  return provider()
}
