import { describe, expect, test } from 'bun:test'
import {
  mayStopTask,
  taskCoordinationAgentId,
} from '../../src/tasks/ownership.js'
import type { TaskState } from '../../src/tasks/types.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'

const ME = 'a1234567890abcdef' as const
const OTHER = 'afedcba0987654321' as const

function shellTask(agentId?: string): LocalShellTaskState {
  return {
    id: 'b12345678',
    type: 'local_bash',
    status: 'running',
    description: 'dev server',
    startTime: 1,
    endTime: undefined,
    outputFile: '/tmp/b12345678.output',
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

describe('mayStopTask', () => {
  test('main thread may stop anything except the main-session pseudo-task', () => {
    expect(mayStopTask(shellTask() as TaskState, undefined)).toBe(true)
    expect(mayStopTask(shellTask(OTHER) as TaskState, undefined)).toBe(true)
    expect(
      mayStopTask(agentTask({ agentId: 's1' }) as TaskState, undefined),
    ).toBe(true)
    expect(
      mayStopTask(
        agentTask({ agentId: 's1', agentType: 'main-session' }) as TaskState,
        undefined,
      ),
    ).toBe(false)
  })

  test('subagent may stop only shell tasks it owns', () => {
    expect(mayStopTask(shellTask(ME) as TaskState, ME)).toBe(true)
    expect(mayStopTask(shellTask(OTHER) as TaskState, ME)).toBe(false)
    expect(mayStopTask(shellTask() as TaskState, ME)).toBe(false) // main-owned
  })

  test('subagent may stop only agents it spawned — not itself, not siblings', () => {
    expect(
      mayStopTask(
        agentTask({ agentId: OTHER, parentAgentId: ME }) as TaskState,
        ME,
      ),
    ).toBe(true)
    // Its own task entry: id === agentId, parent is someone else.
    expect(
      mayStopTask(
        agentTask({ agentId: ME, parentAgentId: OTHER }) as TaskState,
        ME,
      ),
    ).toBe(false)
    // Spawned by the main session.
    expect(mayStopTask(agentTask({ agentId: OTHER }) as TaskState, ME)).toBe(
      false,
    )
  })

  test('main-session pseudo-task is not stoppable by anyone', () => {
    expect(
      mayStopTask(
        agentTask({ agentId: 's1', agentType: 'main-session' }) as TaskState,
        ME,
      ),
    ).toBe(false)
  })
})

describe('taskCoordinationAgentId', () => {
  test('points at the owning agent, or undefined for main-owned', () => {
    expect(taskCoordinationAgentId(shellTask(OTHER) as TaskState)).toBe(OTHER)
    expect(taskCoordinationAgentId(shellTask() as TaskState)).toBeUndefined()
  })

  test('points at the agent itself for agent tasks, never the main session', () => {
    expect(
      taskCoordinationAgentId(agentTask({ agentId: OTHER }) as TaskState),
    ).toBe(OTHER)
    expect(
      taskCoordinationAgentId(
        agentTask({ agentId: 's1', agentType: 'main-session' }) as TaskState,
      ),
    ).toBeUndefined()
  })
})
