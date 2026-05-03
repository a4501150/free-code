import { randomUUID } from 'crypto'
import { getSdkBetas, getSessionId } from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKMessage,
} from 'src/structuredProtocol/index.js'
import type { ApiKeySource } from '../auth.js'
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
} from 'src/tools/AgentTool/constants.js'
import { getAnthropicApiKeyWithSource } from '../auth.js'
import { getCwd } from '../cwd.js'
import { getFastModeState } from '../fastMode.js'

// TODO(next-minor): remove this translation once structured consumers have migrated
// to the 'Agent' tool name. The wire name was renamed Task → Agent in #19647,
// but emitting the new name in init/result events broke structured consumers on a
// patch-level release. Keep emitting 'Task' until the next minor.
export function sdkCompatToolName(name: string): string {
  return name === AGENT_TOOL_NAME ? LEGACY_AGENT_TOOL_NAME : name
}

type CommandLike = { name: string; userInvocable?: boolean }

export type SystemInitInputs = {
  tools: ReadonlyArray<{ name: string }>
  mcpClients: ReadonlyArray<{ name: string; type: string }>
  model: string
  permissionMode: PermissionMode
  commands: ReadonlyArray<CommandLike>
  agents: ReadonlyArray<{ agentType: string }>
  skills: ReadonlyArray<CommandLike>
  plugins: ReadonlyArray<{ name: string; path: string; source: string }>
  fastMode: boolean | undefined
}

/**
 * Build the `system/init` SDKMessage — the first message on the SDK stream
 * carrying session metadata (cwd, tools, model, commands, etc.) that remote
 * clients use to render pickers and gate UI.
 *
 * Called from two paths that must produce identical shapes:
 *   - QueryEngine (print-mode / SDK) — yielded as the first
 *     stream message per query turn
 */
export function buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage {
  const initMessage: SDKMessage = {
    type: 'system',
    subtype: 'init',
    cwd: getCwd(),
    session_id: getSessionId(),
    tools: inputs.tools.map(tool => sdkCompatToolName(tool.name)),
    mcp_servers: inputs.mcpClients.map(client => ({
      name: client.name,
      status: client.type,
    })),
    model: inputs.model,
    permissionMode: inputs.permissionMode,
    slash_commands: inputs.commands
      .filter(c => c.userInvocable !== false)
      .map(c => c.name),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiKeySource: getAnthropicApiKeyWithSource().source as any,
    betas: getSdkBetas(),
    claude_code_version: MACRO.VERSION,
    agents: inputs.agents.map(agent => agent.agentType),
    skills: inputs.skills
      .filter(s => s.userInvocable !== false)
      .map(skill => skill.name),
    plugins: inputs.plugins.map(plugin => ({
      name: plugin.name,
      path: plugin.path,
      source: plugin.source,
    })),
    uuid: randomUUID(),
  }
  ;(initMessage as Record<string, unknown>).fast_mode_state = getFastModeState(
    inputs.model,
    inputs.fastMode,
  )
  return initMessage
}
