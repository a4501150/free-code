// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { BriefTool } from './tools/BriefTool/BriefTool.js'
// Feature-gated tool imports. `feature()` is a Bun build-time macro, so any
// namespace not reached under a disabled flag is DCE'd along with its
// transitive imports.
import * as sleepToolMod from './tools/SleepTool/SleepTool.js'
import * as cronCreateMod from './tools/ScheduleCronTool/CronCreateTool.js'
import * as cronDeleteMod from './tools/ScheduleCronTool/CronDeleteTool.js'
import * as cronListMod from './tools/ScheduleCronTool/CronListTool.js'
import * as sendUserFileMod from './tools/SendUserFileTool/SendUserFileTool.js'
import * as pushNotificationMod from './tools/PushNotificationTool/PushNotificationTool.js'
// REPLTool is not shipped in the OSS source snapshot but may be
// supplied by downstream builds via this path. Keep a try/catch require
// so its absence is tolerated silently.
/* eslint-disable @typescript-eslint/no-require-imports */
let REPLTool: any = null
try { REPLTool = require('./tools/REPLTool/REPLTool.js').REPLTool ?? null } catch { /* REPLTool not available */ }
/* eslint-enable @typescript-eslint/no-require-imports */
const SleepTool = feature('KAIROS') ? sleepToolMod.SleepTool : null
const cronTools = feature('AGENT_TRIGGERS')
  ? [
      cronCreateMod.CronCreateTool,
      cronDeleteMod.CronDeleteTool,
      cronListMod.CronListTool,
    ]
  : []
const SendUserFileTool = feature('KAIROS')
  ? sendUserFileMod.SendUserFileTool
  : null
const PushNotificationTool =
  feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? pushNotificationMod.PushNotificationTool
    : null
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { SendMessageTool } from './tools/SendMessageTool/SendMessageTool.js'
import { TeamCreateTool } from './tools/TeamCreateTool/TeamCreateTool.js'
import { TeamDeleteTool } from './tools/TeamDeleteTool/TeamDeleteTool.js'
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import { isToolSearchEnabledOptimistic } from './utils/toolSearch.js'
import * as verifyPlanMod from './tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js'
// eslint-disable-next-line custom-rules/no-process-env-top-level
const VerifyPlanExecutionTool =
  feature('VERIFY_PLAN') && process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? verifyPlanMod.VerifyPlanExecutionTool
    : null
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
import * as overflowTestMod from './tools/OverflowTestTool/OverflowTestTool.js'
import * as ctxInspectMod from './tools/CtxInspectTool/CtxInspectTool.js'
import * as terminalCaptureMod from './tools/TerminalCaptureTool/TerminalCaptureTool.js'
import * as coordinatorModeMod from './coordinator/coordinatorMode.js'
import * as listPeersMod from './tools/ListPeersTool/ListPeersTool.js'
import * as workflowToolMod from './tools/WorkflowTool/WorkflowTool.js'
import * as workflowBundledMod from './tools/WorkflowTool/bundled/index.js'
import * as powerShellMod from './tools/PowerShellTool/PowerShellTool.js'
const OverflowTestTool = feature('OVERFLOW_TEST_TOOL')
  ? overflowTestMod.OverflowTestTool
  : null
const CtxInspectTool = feature('CONTEXT_COLLAPSE')
  ? ctxInspectMod.CtxInspectTool
  : null
const TerminalCaptureTool = feature('TERMINAL_PANEL')
  ? terminalCaptureMod.TerminalCaptureTool
  : null
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? coordinatorModeMod
  : null
const ListPeersTool = feature('UDS_INBOX') ? listPeersMod.ListPeersTool : null
// initBundledWorkflows has intentional side effects on module bootstrap —
// invoking it here behind the feature gate is the entire reason this branch
// exists in addition to the static import.
let WorkflowTool: typeof workflowToolMod.WorkflowTool | null = null
if (feature('WORKFLOW_SCRIPTS')) {
  workflowBundledMod.initBundledWorkflows()
  WorkflowTool = workflowToolMod.WorkflowTool
}
import type { ToolPermissionContext } from './Tool.js'
import { shouldPreferBashForSearch } from './utils/embeddedTools.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import {
  REPL_TOOL_NAME,
  REPL_ONLY_TOOLS,
  isReplModeEnabled,
} from './tools/REPLTool/constants.js'
export { REPL_ONLY_TOOLS }
const getPowerShellTool = () =>
  isPowerShellToolEnabled() ? powerShellMod.PowerShellTool : null

/**
 * Predefined tool presets that can be used with --tools flag
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * Get the list of tool names for a given preset
 * Filters out tools that are disabled via isEnabled() check
 * @param preset The preset name
 * @returns Array of tool names
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map(tool => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map(tool => tool.name)
}

/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 */
/**
 * NOTE: This MUST stay in sync with https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_code_global_system_caching, in order to cache the system prompt across users.
 */
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // Ant-native builds have bfs/ugrep embedded in the bun binary (same ARGV0
    // trick as ripgrep). When available, find/grep in Claude's shell are aliased
    // to these fast tools, so the dedicated Glob/Grep tools are unnecessary.
    ...(shouldPreferBashForSearch() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    WebFetchTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    TaskCreateTool,
    TaskGetTool,
    TaskUpdateTool,
    TaskListTool,
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    SendMessageTool,
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled() ? [TeamCreateTool, TeamDeleteTool] : []),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(isReplModeEnabled() && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,
    BriefTool,
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    // Include ToolSearchTool when tool search might be enabled (optimistic check)
    // The actual decision to defer tools happens at request time in claude.ts
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}

export {
  assembleToolPool,
  filterToolsByDenyRules,
} from './tools/AgentTool/assembleToolPool.js'
import { filterToolsByDenyRules } from './tools/AgentTool/assembleToolPool.js'

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Simple mode: only Bash, Read, and Edit tools
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    // --bare + REPL mode: REPL wraps Bash/Read/Edit/etc inside the VM, so
    // return REPL instead of the raw primitives. Matches the non-bare path
    // below which also hides REPL_ONLY_TOOLS when REPL is enabled.
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      if (
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
      ) {
        replSimple.push(TaskStopTool, SendMessageTool)
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // When coordinator mode is also active, include AgentTool and TaskStopTool
    // so the coordinator gets Task+TaskStop (via useMergedTools filtering) and
    // workers get Bash/Read/Edit (via filterToolsForAgent filtering).
    if (
      feature('COORDINATOR_MODE') &&
      coordinatorModeModule?.isCoordinatorMode()
    ) {
      simpleTools.push(AgentTool, TaskStopTool, SendMessageTool)
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // Get all base tools and filter out special tools that get added conditionally
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // Filter out tools that are denied by the deny rules
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // When REPL mode is enabled, hide primitive tools from direct use.
  // They're still accessible inside REPL via the VM context.
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * Get all tools including both built-in tools and MCP tools.
 *
 * This is the preferred function when you need the complete tools list for:
 * - Tool search threshold calculations (isToolSearchEnabled)
 * - Token counting that includes MCP tools
 * - Any context where MCP tools should be considered
 *
 * Use getTools() only when you specifically need just built-in tools.
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined array of built-in and MCP tools
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
