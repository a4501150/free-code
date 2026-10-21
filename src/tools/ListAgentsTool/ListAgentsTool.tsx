import { z } from 'zod/v4'
import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { TaskStateBase } from '../../Task.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  isLocalAgentTask,
  resolveParentAgentId,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import type { TaskState } from '../../tasks/types.js'
import { listLiveSessions } from '../../utils/concurrentSessions.js'
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
  /** Present when called from a subagent: the spawning agent ("main-session"
   * when the caller is depth-1). */
  parent?: AgentRow | 'main-session'
  agents: AgentRow[]
  sessions: SessionRow[]
}

export function formatListAgentsResult(output: Output): string {
  const lines: string[] = []
  const formatAgentLine = (
    prefix: 'parent' | 'agent',
    row: AgentRow,
    toAddr: string,
  ) => {
    const name = row.name ? ` "${row.name}"` : ''
    return `${prefix} ${row.id}${name} [${row.status}] — ${row.description} — SendMessage to:"${toAddr}"`
  }
  if (output.parent === 'main-session') {
    lines.push('parent (main session) — SendMessage to:"parent"')
  } else if (output.parent) {
    lines.push(formatAgentLine('parent', output.parent, 'parent'))
  }
  for (const agent of output.agents) {
    lines.push(formatAgentLine('agent', agent, agent.name ?? agent.id))
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
          dimColor={
            !line.startsWith('agent ') &&
            !line.startsWith('session ') &&
            !line.startsWith('parent ')
          }
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
  outputSchema: z.object({
    parent: z
      .union([
        z.object({
          id: z.string(),
          name: z.string().optional(),
          description: z.string(),
          status: z.string(),
        }),
        z.literal('main-session'),
      ])
      .optional(),
    agents: z.array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string(),
        status: z.string(),
      }),
    ),
    sessions: z.array(
      z.object({
        session_id: z.string(),
        session_kind: z.string(),
        pid: z.number(),
        cwd: z.string(),
        name: z.string().optional(),
      }),
    ),
  }),
  async description() {
    return 'List agents and sessions you can message'
  },
  async prompt() {
    return DESCRIPTION
  },
  isEnabled() {
    // Mirrors SendMessage: every mode can discover its messaging targets.
    return true
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
  async call(_input, { getAppState, agentId }) {
    const appState = getAppState()
    const tasks = (appState.tasks ?? {}) as Record<string, TaskState>

    // Name → agentId; invert it so a named agent shows its name too.
    const nameById = new Map<string, string>()
    for (const [name, id] of appState.agentNameRegistry ?? []) {
      nameById.set(String(id), name)
    }

    const toAgentRow = (task: TaskState): AgentRow => {
      const base = task as TaskStateBase
      const name = nameById.get(base.id)
      return {
        id: base.id,
        ...(name ? { name } : {}),
        description: base.description,
        status: base.status,
      }
    }

    // From a subagent: surface the spawning agent (or the main session for
    // a depth-1 caller) so the caller learns its "parent" address.
    const [liveSessions, parentAgentId] = await Promise.all([
      listLiveSessions(),
      agentId
        ? resolveParentAgentId(agentId, tasks)
        : Promise.resolve(undefined),
    ])
    let parent: Output['parent']
    if (agentId) {
      if (parentAgentId === undefined) {
        parent = 'main-session'
      } else {
        const parentTask = tasks[parentAgentId]
        parent = parentTask
          ? toAgentRow(parentTask)
          : // Evicted from state — the address still routes via SendMessage
            // (auto-resume from transcript), so list it with that status.
            { id: parentAgentId, description: '(evicted)', status: 'stopped' }
      }
    }

    const agents: AgentRow[] = Object.values(tasks)
      .filter(t => isLocalAgentTask(t) && !isMainSessionTask(t))
      .map(toAgentRow)

    const sessions: SessionRow[] = liveSessions
      .filter(s => s.pid !== process.pid)
      .map(s => ({
        session_id: s.sessionId,
        session_kind: s.kind,
        pid: s.pid,
        cwd: s.cwd,
        ...(s.name ? { name: s.name } : {}),
      }))

    return { data: { ...(parent ? { parent } : {}), agents, sessions } }
  },
} satisfies ToolDef<InputSchema, Output>)
