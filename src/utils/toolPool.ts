import partition from 'lodash-es/partition.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import { isMcpTool } from '../services/mcp/utils.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'

import * as coordinatorModeModule from '../coordinator/coordinatorMode.js'

/**
 * Filters a tool array to the set allowed in coordinator mode.
 * Shared between the REPL path (mergeAndFilterTools) and the headless
 * path (main.tsx) so both stay in sync.
 *
 * MCP tools stay in the pool: they never ride the request tools[] array
 * unless their server opts into alwaysLoad (claude.ts filters by
 * isToolExposedToModel), and the coordinator reaches them through the
 * RunCode catalog — a filter here would starve the catalog render, the
 * mcp_tools_delta / mcp_instructions_delta announcements and the bridge's
 * mcp/<server> dispatch, all of which read this thread's tool list.
 */
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools.filter(
    t => COORDINATOR_MODE_ALLOWED_TOOLS.has(t.name) || isMcpTool(t),
  )
}

/**
 * Pure function that merges tool pools and applies coordinator mode filtering.
 *
 * Lives in a React-free file so print.ts can import it without pulling
 * react/ink into the SDK module graph. The useMergedTools hook delegates
 * to this function inside useMemo.
 *
 * @param initialTools - Extra tools to include (built-in + startup MCP from props).
 * @param assembled - Tools from assembleToolPool (built-in + MCP, deduped).
 * @param mode - The permission context mode.
 * @returns Merged, deduplicated, and coordinator-filtered tool array.
 */
export function mergeAndFilterTools(
  initialTools: Tools,
  assembled: Tools,
  mode: ToolPermissionContext['mode'],
): Tools {
  // Merge initialTools on top - they take precedence in deduplication.
  // initialTools may include built-in tools (from getTools() in REPL.tsx) which
  // overlap with assembled tools. uniqBy handles this deduplication.
  // Partition-sort for prompt-cache stability (same as assembleToolPool):
  // built-ins must stay a contiguous prefix for the server's cache policy.
  const [mcp, builtIn] = partition(
    uniqBy([...initialTools, ...assembled], 'name'),
    isMcpTool,
  )
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  const tools = [...builtIn.sort(byName), ...mcp.sort(byName)]

  if (coordinatorModeModule.isCoordinatorMode()) {
    return applyCoordinatorToolFilter(tools)
  }

  return tools
}
