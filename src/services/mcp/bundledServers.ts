import { prepareAgentBrowserSidecar } from '../../utils/agentBrowserSidecar.js'
import type { ScopedMcpServerConfig } from './types.js'

// Servers that ship inside this build instead of a config file. Injected at
// LOWEST precedence: any manually-configured server with the same key
// replaces it, and callers that replace the whole file-based set
// (--strict-mcp-config, bare mode) exclude these automatically.

export const AGENT_BROWSER_SERVER_NAME = 'agent-browser'

/**
 * The vendored agent-browser MCP server (web_search/web_fetch/browser_*) when
 * this platform has the sidecar. Enabled by default — opt out goes through
 * the ordinary per-project disabledMcpServers list, so it participates in
 * `isMcpServerDisabled` like any user-configured server.
 *
 * manualNames: keys present in the user/project/local sets. A manual entry
 * for the same key means the user is deliberately running their own
 * agent-browser (often a local dev build); skip injection so the manual
 * process is the only one that connects.
 */
export async function getBundledMcpServers(
  manualNames: Set<string>,
): Promise<Record<string, ScopedMcpServerConfig>> {
  if (manualNames.has(AGENT_BROWSER_SERVER_NAME)) return {}
  const command = await prepareAgentBrowserSidecar()
  if (!command) return {}
  return {
    [AGENT_BROWSER_SERVER_NAME]: {
      type: 'stdio',
      command,
      args: [],
      scope: 'dynamic',
    },
  }
}
