import { z } from 'zod/v4'
import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { TaskStateBase } from '../../Task.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorModeGate.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import type { TaskState } from '../../tasks/types.js'
import { listLiveSessions } from '../../utils/concurrentSessions.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { LIST_AGENTS_TOOL_NAME, DESCRIPTION } from './constants.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema

interface AgentRow {
  id: string
  name?: string
  description: string
  status: string
}

interface SessionRow {
  session_id: string
  session_kind: string
  pid: number
  cwd: string
  name?: string
}

interface Output {
  agents: AgentRow[]
  sessions: SessionRow[]
}

export function formatListAgentsResult(output: Output): string {
  const lines: string[] = []
  for (const agent of output.agents) {
    const name = agent.name ? ` "${agent.name}"` : ''
    lines.push(
      `agent ${agent.id}${name} [${agent.status}] — ${agent.description} — SendMessage to:"${agent.name ?? agent.id}"`,
    )
  }
  for (const session of output.sessions) {
    const name = session.name ? ` "${session.name}"` : ''
    lines.push(
      `session ${session.session_id} (${session.session_kind}, pid ${session.pid})${name} — SendMessage to:"session:${session.session_id}"`,
    )
  }
  return lines.length > 0 ? lines.join('\n') : 'No messaging peers yet.'
}

export function renderToolResultMessage(content: unknown): React.ReactNode {
  const lines = formatListAgentsResult(content as Output).split('\n')
  return (
    <MessageResponse>
      {lines.map((line, i) => (
        <Text
          key={i}
          dimColor={!line.startsWith('agent ') && !line.startsWith('session ')}
        >
          {line}
        </Text>
      ))}
    </MessageResponse>
  )
}

export const ListAgentsTool = buildTool({
  name: LIST_AGENTS_TOOL_NAME,
  userFacingName: () => 'List Agents',
  async description() {
    return 'List agents and sessions you can message'
  },
  async prompt() {
    return DESCRIPTION
  },
  isEnabled() {
    // Mirrors SendMessage: the orchestrating modes must be able to discover
    // what they may message.
    return isAgentSwarmsEnabled() || isCoordinatorMode()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  get inputSchema(): InputSchema {
    return inputSchema
  },
  renderToolUseMessage() {
    return 'Listing messaging targets...'
  },
  renderToolResultMessage,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatListAgentsResult(output),
    }
  },
  async call(_input, { getAppState }) {
    const appState = getAppState()
    const allTasks = Object.values(appState.tasks ?? {}) as TaskState[]

    // Name → agentId; invert it so a named agent shows its name too.
    const nameById = new Map<string, string>()
    for (const [name, id] of appState.agentNameRegistry ?? []) {
      nameById.set(String(id), name)
    }

    const agents: AgentRow[] = allTasks
      .filter(t => isLocalAgentTask(t) && !isMainSessionTask(t))
      .map(t => {
        const base = t as TaskStateBase
        const name = nameById.get(base.id)
        return {
          id: base.id,
          ...(name ? { name } : {}),
          description: base.description,
          status: base.status,
        }
      })

    const sessions: SessionRow[] = (await listLiveSessions())
      .filter(s => s.pid !== process.pid)
      .map(s => ({
        session_id: s.sessionId,
        session_kind: s.kind,
        pid: s.pid,
        cwd: s.cwd,
        ...(s.name ? { name: s.name } : {}),
      }))

    return { data: { agents, sessions } }
  },
} satisfies ToolDef<InputSchema, Output>)
