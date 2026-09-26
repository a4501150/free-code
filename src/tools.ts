// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { type Tool, type Tools } from './Tool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { InvokeTool } from './tools/InvokeToolTool/InvokeToolTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { BackgroundTaskListTool } from './tools/BackgroundTaskListTool/BackgroundTaskListTool.js'
import { BriefTool } from './tools/BriefTool/BriefTool.js'
import { CronCreateTool } from './tools/ScheduleCronTool/CronCreateTool.js'
import { CronDeleteTool } from './tools/ScheduleCronTool/CronDeleteTool.js'
import { CronListTool } from './tools/ScheduleCronTool/CronListTool.js'
import { SendUserFileTool } from './tools/SendUserFileTool/SendUserFileTool.js'
import { PushNotificationTool } from './tools/PushNotificationTool/PushNotificationTool.js'
const cronTools = [CronCreateTool, CronDeleteTool, CronListTool]
import { ExitPlanModeTool } from './tools/ExitPlanModeTool/ExitPlanModeTool.js'
import { SendMessageTool } from './tools/SendMessageTool/SendMessageTool.js'
import { ListAgentsTool } from './tools/ListAgentsTool/ListAgentsTool.js'
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import * as verifyPlanMod from './tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js'
// eslint-disable-next-line custom-rules/no-process-env-top-level
const VerifyPlanExecutionTool =
  feature('VERIFY_PLAN') && process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? verifyPlanMod.VerifyPlanExecutionTool
    : null
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
export { ALL_AGENT_DISALLOWED_TOOLS } from './constants/tools.js'
import * as coordinatorModeMod from './coordinator/coordinatorMode.js'
import * as powerShellMod from './tools/PowerShellTool/PowerShellTool.js'
import type { ToolPermissionContext } from './Tool.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
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
  const powerShellTool = getPowerShellTool()
  return [
    AgentTool,
    BashTool,
    ExitPlanModeTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    TaskStopTool,
    BackgroundTaskListTool,
    AskUserQuestionTool,
    SkillTool,
    InvokeTool,
    EnterPlanModeTool,
    TaskCreateTool,
    TaskGetTool,
    TaskUpdateTool,
    TaskListTool,
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    SendMessageTool,
    ListAgentsTool,
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...cronTools,
    BriefTool,
    SendUserFileTool,
    PushNotificationTool,
    ...(powerShellTool ? [powerShellTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
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
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // When coordinator mode is also active, include AgentTool and TaskStopTool
    // so the coordinator gets Task+TaskStop (via useMergedTools filtering) and
    // workers get Bash/Read/Edit (via filterToolsForAgent filtering).
    if (coordinatorModeMod.isCoordinatorMode()) {
      simpleTools.push(AgentTool, TaskStopTool, SendMessageTool, ListAgentsTool)
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

  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
