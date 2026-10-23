import { describe, expect, test } from 'bun:test'
import { BackgroundTaskStopTool } from '../../src/tools/BackgroundTaskStopTool/BackgroundTaskStopTool.js'
import { BackgroundTaskListTool } from '../../src/tools/BackgroundTaskListTool/BackgroundTaskListTool.js'
import type { TaskState } from '../../src/tasks/types.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { AgentId } from '../../src/types/ids.js'

const ME: AgentId = 'a1234567890abcdef'
const OTHER: AgentId = 'afedcba0987654321'
const CHILD: AgentId = 'a1111222233334444'

function shellTask(
  id: string,
  agentId?: AgentId,
  status = 'running',
): LocalShellTaskState {
  return {
    id,
    type: 'local_bash',
    status,
    description: 'dev server',
    startTime: 1,
    outputFile: `/tmp/${id}.output`,
    command: 'npm run dev',
    result: undefined,
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    ...(agentId !== undefined ? { agentId } : {}),
  } as LocalShellTaskState
}

function agentTask(fields: {
  agentId: string
  parentAgentId?: string
  agentType?: string
  status?: string
}): LocalAgentTaskState {
  return {
    id: fields.agentId,
    type: 'local_agent',
    status: fields.status ?? 'running',
    description: 'research task',
    startTime: 1,
    outputFile: '/tmp/out.jsonl',
    agentId: fields.agentId,
    ...(fields.parentAgentId !== undefined
      ? { parentAgentId: fields.parentAgentId }
      : {}),
    prompt: 'do the thing',
    agentType: fields.agentType ?? 'general-purpose',
    pendingMessages: [],
    isBackgrounded: true,
    retain: false,
  } as unknown as LocalAgentTaskState
}

function context(
  tasks: TaskState[],
  opts: { agentId?: AgentId; names?: Map<string, AgentId> } = {},
) {
  const byId: Record<string, TaskState> = {}
  for (const t of tasks) byId[t.id] = t
  return {
    agentId: opts.agentId,
    getAppState: () => ({
      tasks: byId,
      agentNameRegistry: opts.names ?? new Map<string, AgentId>(),
    }),
  } as never
}

describe('BackgroundTaskStopTool.validateInput ownership', () => {
  const tasks: TaskState[] = [
    shellTask('b0000001', ME),
    shellTask('b0000002', OTHER),
    shellTask('b0000003'),
    agentTask({ agentId: CHILD, parentAgentId: ME }),
    agentTask({ agentId: OTHER }),
  ]

  test('subagent may stop its own shell task', async () => {
    const result = await BackgroundTaskStopTool.validateInput?.(
      { task_id: 'b0000001' },
      context(tasks, { agentId: ME }),
    )
    expect(result?.result).toBe(true)
  })

  test('subagent may stop an agent it spawned', async () => {
    const result = await BackgroundTaskStopTool.validateInput?.(
      { task_id: CHILD },
      context(tasks, { agentId: ME }),
    )
    expect(result?.result).toBe(true)
  })

  test('subagent may not stop a foreign shell task; denial carries the owner address', async () => {
    const result = await BackgroundTaskStopTool.validateInput?.(
      { task_id: 'b0000002' },
      context(tasks, { agentId: ME }),
    )
    expect(result?.result).toBe(false)
    const message = (result as { message?: string }).message ?? ''
    expect(message).toContain(OTHER)
    expect(message).toContain(`SendMessage to: "${OTHER}"`)
  })

  test('subagent may not stop a main-session task; denial says so', async () => {
    const result = await BackgroundTaskStopTool.validateInput?.(
      { task_id: 'b0000003' },
      context(tasks, { agentId: ME }),
    )
    expect(result?.result).toBe(false)
    expect((result as { message?: string }).message).toContain(
      'the main session',
    )
  })

  test('main thread may stop any task', async () => {
    for (const id of ['b0000002', 'b0000003', OTHER]) {
      const result = await BackgroundTaskStopTool.validateInput?.(
        { task_id: id },
        context(tasks),
      )
      expect(result?.result).toBe(true)
    }
  })

  test('denial resolves the owner name when registered', async () => {
    const names = new Map([['worker-bee', OTHER]])
    const result = await BackgroundTaskStopTool.validateInput?.(
      { task_id: 'b0000002' },
      context(tasks, { agentId: ME, names }),
    )
    expect((result as { message?: string }).message).toContain('worker-bee')
  })
})

describe('BackgroundTaskListTool.call scoping', () => {
  const tasks: TaskState[] = [
    shellTask('b0000001', ME),
    shellTask('b0000002', OTHER, 'completed'),
    shellTask('b0000003'),
    agentTask({ agentId: CHILD, parentAgentId: ME }),
    agentTask({ agentId: 's1', agentType: 'main-session' }),
  ]

  test('subagent sees own tasks in full and others only as running hints', async () => {
    // Include the caller's own agent entry (slow foreground agents register
    // one) — it must appear in neither section.
    const withSelf = [
      ...tasks,
      agentTask({ agentId: ME, parentAgentId: OTHER }),
    ]
    const output = await BackgroundTaskListTool.call(
      {},
      context(withSelf, { agentId: ME }),
    )
    const data = output.data as {
      count: number
      tasks: Array<{ task_id: string }>
      other_running_tasks?: Array<{ task_id: string; owner: string }>
    }

    // Own section: my bash + my spawned agent. Not my own agent entry,
    // not the main-session pseudo-task.
    expect(data.tasks.map(t => t.task_id).sort()).toEqual(
      ['b0000001', CHILD].sort(),
    )
    // Hints: only OTHER agents' RUNNING tasks — the completed foreign bash,
    // the main-session row, and my own agent entry are excluded.
    expect(data.other_running_tasks?.map(t => t.task_id)).toEqual(['b0000003'])
    expect(data.other_running_tasks?.[0].owner).toBe('main')
  })

  test('hint owner carries the owning agent id and registered name', async () => {
    const running = [
      shellTask('b0000002', OTHER),
      ...tasks.filter(t => t.type === 'local_agent'),
    ]
    const names = new Map([['worker-bee', OTHER]])
    const output = await BackgroundTaskListTool.call(
      {},
      context(running, { agentId: ME, names }),
    )
    const data = output.data as {
      other_running_tasks?: Array<{ owner: string; owner_name?: string }>
    }
    const hint = data.other_running_tasks?.find(h => h.owner === OTHER)
    expect(hint?.owner_name).toBe('worker-bee')
  })

  test('main thread sees the full registry with no hint section', async () => {
    const output = await BackgroundTaskListTool.call({}, context(tasks))
    const data = output.data as {
      count: number
      tasks: Array<{ task_id: string; owner?: string }>
      other_running_tasks?: unknown[]
    }
    // Everything except the main-session pseudo-task, each labeled with owner.
    expect(data.count).toBe(4)
    expect(data.other_running_tasks).toBeUndefined()
    const mine = data.tasks.find(t => t.task_id === 'b0000001')
    expect(mine?.owner).toBe(ME)
    const mainOwned = data.tasks.find(t => t.task_id === 'b0000003')
    expect(mainOwned?.owner).toBe('main')
  })
})
