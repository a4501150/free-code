import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { TaskState } from '../../src/tasks/types.js'
import { SendMessageTool } from '../../src/tools/SendMessageTool/SendMessageTool.js'
import {
  clearCommandQueue,
  getCommandQueue,
} from '../../src/utils/messageQueueManager.js'
import { makeLocalAgentTask } from '../helpers/taskFixtures.js'

function makeContext(
  tasks: Record<string, TaskState>,
  options?: { agentId?: string; names?: Record<string, string> },
) {
  let state = {
    tasks,
    agentNameRegistry: new Map(Object.entries(options?.names ?? {})),
  } as unknown as AppState
  const setAppState = (f: (prev: AppState) => AppState): void => {
    state = f(state)
  }
  return {
    context: {
      getAppState: () => state,
      setAppState,
      setAppStateForTasks: setAppState,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
    } as never,
    getState: () => state,
  }
}

const canUseTool = (async () => ({ behavior: 'allow' as const })) as never

describe('SendMessageTool routing', () => {
  test('"parent" from the main session is rejected', async () => {
    const { context } = makeContext({})
    const result = await SendMessageTool.call(
      { to: 'parent', message: 'hi' },
      context,
      canUseTool,
      undefined,
    )
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('only available from a subagent')
  })

  test('"parent" from a depth-1 agent enqueues a main-session notification', async () => {
    clearCommandQueue()
    const child = makeLocalAgentTask({ id: 'achild0000000001' })
    const { context } = makeContext(
      { [child.id as string]: child },
      { agentId: child.id },
    )
    const result = await SendMessageTool.call(
      { to: 'parent', message: 'status: halfway done' },
      context,
      canUseTool,
      undefined,
    )
    expect(result.data.success).toBe(true)

    const queued = getCommandQueue().find(
      cmd =>
        cmd.mode === 'task-notification' &&
        cmd.origin?.kind === 'agent-message',
    )
    expect(queued).toBeDefined()
    expect(queued!.value).toBe('status: halfway done')
    expect(queued!.agentId).toBeUndefined()
    expect((queued!.origin as { from?: string }).from).toBe(child.id)
    clearCommandQueue()
  })

  test('"parent" to a running subagent parent queues a pending message', async () => {
    const parent = makeLocalAgentTask({ id: 'aparent000000001' })
    const child = makeLocalAgentTask({
      id: 'achild0000000001',
      parentAgentId: parent.id as string,
    })
    const { context, getState } = makeContext(
      {
        [parent.id as string]: parent,
        [child.id as string]: child,
      },
      { agentId: child.id },
    )
    const result = await SendMessageTool.call(
      { to: 'parent', message: 'need a decision' },
      context,
      canUseTool,
      undefined,
    )
    expect(result.data.success).toBe(true)
    expect(result.data.message).toContain('next tool round')
    const parentTask = getState().tasks[parent.id as string] as unknown as {
      pendingMessages: string[]
    }
    expect(parentTask.pendingMessages).toContain('need a decision')
  })

  test('name routing queues a pending message on a running agent', async () => {
    const scout = makeLocalAgentTask({ id: 'ascout00000000001' })
    const { context, getState } = makeContext(
      { [scout.id as string]: scout },
      { names: { scout: scout.id as string } },
    )
    const result = await SendMessageTool.call(
      { to: 'scout', message: 'ping' },
      context,
      canUseTool,
      undefined,
    )
    expect(result.data.success).toBe(true)
    const task = getState().tasks[scout.id as string] as unknown as {
      pendingMessages: string[]
    }
    expect(task.pendingMessages).toContain('ping')
  })

  test('unknown recipient returns an error naming ListAgents and parent', async () => {
    const { context } = makeContext({})
    const result = await SendMessageTool.call(
      { to: 'nobody', message: 'ping' },
      context,
      canUseTool,
      undefined,
    )
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('Unknown recipient')
    expect(result.data.message).toContain('ListAgents')
    expect(result.data.message).toContain('parent')
  })
})
