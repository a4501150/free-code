import { FinishRunTool } from '../tools/FinishRunTool/FinishRunTool.js'
import type { Tools } from '../Tool.js'

/**
 * Tools that exist only inside subagent runs (FinishRunTool is injected by
 * runAgent into subagent pools, never into the global pool) but whose
 * tool_use blocks appear in agent transcripts this process renders.
 * Appended at render time so AssistantToolUseMessage resolves their rows
 * instead of dropping them ("Tool FinishRun not found" → null). Never add
 * these to a request toolset — the request tool list must stay byte-stable.
 */
export function appendRenderOnlyTools(tools: Tools): Tools {
  return tools.some(tool => tool.name === FinishRunTool.name)
    ? tools
    : [...tools, FinishRunTool]
}
