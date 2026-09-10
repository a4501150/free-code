// Which tools the model sees in the API tools[] array. Cataloged tools stay
// in the caller's tool pool (dispatch, permissions and enumerators need them)
// but are filtered out of the request, so the tools block freezes for the
// whole session. Settings are read once per process, so exposure is stable
// within a session; changing them takes effect at next session start.

import type { Tool } from '../../Tool.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'

export const INVOKE_TOOL_NAME = 'InvokeTool'

export function mcpToolCatalogDisabled(): boolean {
  return getSettings_DEPRECATED()?.disableMcpToolCatalog === true
}

// Per-server alwaysLoad opt-out (official parity): a server whose config sets
// `alwaysLoad: true` skips deferral and rides the API tools[] array directly.
// Only user-global mcpServers entries (freecode.json) are consulted; importing
// the scoped MCP config loader here would form an import cycle through
// InvokeToolTool. Project-scope servers ignore alwaysLoad.
function serverAlwaysLoad(serverName: string): boolean {
  const servers = getSettings_DEPRECATED()?.mcpServers as
    | Record<string, { alwaysLoad?: boolean }>
    | undefined
  return servers?.[serverName]?.alwaysLoad === true
}

export function isToolExposedToModel(
  tool: Pick<Tool, 'name' | 'isMcp' | 'mcpInfo'>,
): boolean {
  // The kill switch restores pre-catalog behavior: everything in the request.
  if (mcpToolCatalogDisabled()) return true
  if (tool.isMcp) {
    const server = tool.mcpInfo?.serverName
    return server !== undefined && serverAlwaysLoad(server)
  }
  // The dispatcher itself must stay callable however the setting is set,
  // or cataloged tools become unreachable.
  if (tool.name === INVOKE_TOOL_NAME) return true
  const lazy = getSettings_DEPRECATED()?.lazyTools
  return !(Array.isArray(lazy) && lazy.includes(tool.name))
}
