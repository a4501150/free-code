import { z } from 'zod/v4'
import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { BashTaskKind } from '../../tasks/LocalShellTask/guards.js'
import { mayStopTask } from '../../tasks/ownership.js'
import type { TaskState } from '../../tasks/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { BACKGROUND_TASK_LIST_TOOL_NAME, DESCRIPTION } from './constants.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema

interface TaskSummary {
  task_id: string
  task_type: string
  // Monitor-kind shells run via the MonitorManager; the model needs to tell
  // them apart from a plain shell.
  kind?: BashTaskKind
  status: string
  description: string
  start_time: number
  end_time?: number
  output_file: string
  command?: string
  exit_code?: number
  agent_type?: string
  model?: string
  // Owning agent ID ('main' for the main session) — lets the model tell its
  // own tasks from other agents' when coordinating conflicts.
  owner?: string
  owner_name?: string
}

// Read-only rows for OTHER agents' running tasks, shown to subagent callers
// so they can spot conflicts and coordinate via SendMessage.
interface OtherTaskHint {
  task_id: string
  task_type: string
  kind?: BashTaskKind
  status: string
  description: string
  command?: string
  owner: string
  owner_name?: string
}

interface Output {
  count: number
  tasks: TaskSummary[]
  other_running_tasks?: OtherTaskHint[]
}

function nameForAgentId(
  registry: Map<string, AgentId> | undefined,
  agentId: AgentId | undefined,
): string | undefined {
  if (!registry || !agentId) return undefined
  for (const [name, id] of registry) {
    if (id === agentId) return name
  }
  return undefined
}

function toSummary(
  task: TaskState,
  owner?: string,
  ownerName?: string,
): TaskSummary {
  const base: TaskSummary = {
    task_id: task.id,
    task_type: task.type,
    status: task.status,
    description: task.description,
    start_time: task.startTime,
    output_file: task.outputFile,
  }
  if (owner !== undefined) {
    base.owner = owner
    if (ownerName !== undefined) base.owner_name = ownerName
  }
  if (task.endTime) {
    base.end_time = task.endTime
  }
  if (task.type === 'local_bash') {
    base.command = task.command
    base.kind = task.kind
    if (task.result?.code !== undefined) {
      base.exit_code = task.result.code
    }
  }
  if (task.type === 'local_agent') {
    base.agent_type = task.agentType
    base.model = task.model
  }
  return base
}

function toHint(
  task: TaskState,
  owner: string,
  ownerName?: string,
): OtherTaskHint {
  const hint: OtherTaskHint = {
    task_id: task.id,
    task_type: task.type,
    status: task.status,
    description: task.description,
    owner,
  }
  if (ownerName !== undefined) hint.owner_name = ownerName
  if (task.type === 'local_bash') {
    hint.command = task.command
    hint.kind = task.kind
  }
  return hint
}

// Owning agent of a task: the agentId stamp for bash/monitor tasks, the
// agent's own id for agent tasks ('main' when unowned/main-session).
function taskOwnerAgentId(task: TaskState): AgentId | undefined {
  if (task.type === 'local_bash') return task.agentId
  if (task.type === 'local_agent') {
    return task.agentType === 'main-session'
      ? undefined
      : (task.agentId as AgentId)
  }
  return undefined
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (output.count === 0 && (output.other_running_tasks?.length ?? 0) === 0) {
    return (
      <MessageResponse height={1}>
        <Text>No background tasks.</Text>
      </MessageResponse>
    )
  }

  // One row per task — the same facts the model gets, so an expand of this
  // result is never less informative than the tool_result itself.
  return (
    <MessageResponse>
      {output.tasks.map(task => {
        const kind = task.kind ?? task.task_type.replace(/^local_/, '')
        const exit =
          task.exit_code !== undefined ? ` · exit ${task.exit_code}` : ''
        const agent = task.agent_type ? ` · ${task.agent_type}` : ''
        const owner =
          task.owner && task.owner !== 'main'
            ? ` · owner ${task.owner_name ?? task.owner}`
            : ''
        return (
          <Text key={task.task_id} dimColor={task.status !== 'running'}>
            {`[${task.status}] ${kind} — ${task.description}${agent}${owner}${exit}`}
          </Text>
        )
      })}
      {(output.other_running_tasks ?? []).map(hint => {
        const kind = hint.kind ?? hint.task_type.replace(/^local_/, '')
        const ownerLabel = hint.owner_name ?? hint.owner
        return (
          <Text key={hint.task_id} dimColor>
            {`[hint] [${hint.status}] ${kind} — ${hint.description} · owned by ${ownerLabel} → SendMessage to: "${hint.owner}"`}
          </Text>
        )
      })}
    </MessageResponse>
  )
}

export const BackgroundTaskListTool = buildTool({
  name: BACKGROUND_TASK_LIST_TOOL_NAME,
  userFacingName: () => 'List Background Tasks',
  get inputSchema(): InputSchema {
    return inputSchema
  },
  outputSchema: z.object({
    count: z.number(),
    tasks: z.array(
      z.object({
        task_id: z.string(),
        task_type: z.string(),
        kind: z.enum(['bash', 'monitor']).optional(),
        status: z.string(),
        description: z.string(),
        start_time: z.number(),
        end_time: z.number().optional(),
        output_file: z.string(),
        command: z.string().optional(),
        exit_code: z.number().optional(),
        agent_type: z.string().optional(),
        model: z.string().optional(),
        owner: z.string().optional(),
        owner_name: z.string().optional(),
      }),
    ),
    other_running_tasks: z
      .array(
        z.object({
          task_id: z.string(),
          task_type: z.string(),
          kind: z.enum(['bash', 'monitor']).optional(),
          status: z.string(),
          description: z.string(),
          command: z.string().optional(),
          owner: z.string(),
          owner_name: z.string().optional(),
        }),
      )
      .optional(),
  }),
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return "List background tasks you own, plus hints on other agents' running tasks"
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage() {
    return 'Listing background tasks...'
  },
  renderToolResultMessage,
  async call(_input, { getAppState, agentId }) {
    const appState = getAppState()
    const allTasks = Object.values(appState.tasks ?? {})
    const registry = appState.agentNameRegistry

    const ownTasks = allTasks
      .filter(task => mayStopTask(task, agentId))
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1
        if (a.status !== 'running' && b.status === 'running') return 1
        return b.startTime - a.startTime
      })
      .map(task => {
        const ownerAgentId = taskOwnerAgentId(task)
        return toSummary(
          task,
          ownerAgentId ?? 'main',
          nameForAgentId(registry, ownerAgentId),
        )
      })

    // Subagent callers additionally get read-only hints on other agents'
    // running tasks (never terminal ones — those are noise) so they can
    // spot conflicts and coordinate. Main-thread callers already see the
    // full registry above; no hint section for them. The caller's own agent
    // entry (a slow foreground agent registers itself) is excluded — an
    // agent must not get a hint about itself.
    let otherRunning: OtherTaskHint[] | undefined
    if (agentId !== undefined) {
      otherRunning = allTasks
        .filter(
          task =>
            !mayStopTask(task, agentId) &&
            task.status === 'running' &&
            taskOwnerAgentId(task) !== agentId &&
            !(task.type === 'local_agent' && task.agentType === 'main-session'),
        )
        .map(task => {
          const ownerAgentId = taskOwnerAgentId(task)
          return toHint(
            task,
            ownerAgentId ?? 'main',
            nameForAgentId(registry, ownerAgentId),
          )
        })
    }

    return {
      data: {
        count: ownTasks.length,
        tasks: ownTasks,
        ...(otherRunning ? { other_running_tasks: otherRunning } : {}),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
