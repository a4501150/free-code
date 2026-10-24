/**
 * Post-compact background-task re-announce coverage.
 *
 * Compaction eats the spawn tool_result rows, so
 * createBackgroundTaskAttachmentsIfNeeded is the only thing that tells the
 * post-compact model that a backgrounded agent/bash/monitor is still
 * running. These tests pin the per-kind scoping: every background task kind
 * the compacting thread owns is re-announced, and everything else
 * (foreground shells, other agents' tasks, dream housekeeping) is not.
 */

import { describe, expect, test } from 'bun:test'
import { createBackgroundTaskAttachmentsIfNeeded } from '../../src/services/compact/compact.js'
import { normalizeAttachmentForAPI } from '../../src/utils/messages.js'
import type { ToolUseContext } from '../../src/Tool.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import type { TaskState } from '../../src/tasks/types.js'
import type { AgentId } from '../../src/types/ids.js'
import type { AppState } from '../../src/state/AppStateStore.js'

type AttachmentOf = { type: string } & Record<string, unknown>

function makeContext(
  tasks: Record<string, TaskState>,
  agentId?: AgentId,
): Pick<ToolUseContext, 'getAppState' | 'agentId'> {
  return {
    agentId,
    getAppState: () => ({ tasks }) as AppState,
  }
}

function makeBashTask(
  partial: Partial<LocalShellTaskState>,
): LocalShellTaskState {
  return {
    id: 'bash_1',
    type: 'local_bash',
    status: 'running',
    description: 'probe command',
    command: 'sleep 300',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    startTime: Date.now(),
    outputFile: '/tmp/bash_1.output',
    outputOffset: 0,
    notified: false,
    ...partial,
  } as LocalShellTaskState
}

function makeAgentTask(
  partial: Partial<LocalAgentTaskState>,
): LocalAgentTaskState {
  return {
    id: 'agent_1',
    type: 'local_agent',
    status: 'running',
    description: 'probe agent',
    agentId: 'a_agent_1',
    agentType: 'general-purpose',
    retrieved: false,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    startTime: Date.now(),
    outputFile: '/tmp/agent_1.output',
    outputOffset: 0,
    notified: false,
    ...partial,
  } as LocalAgentTaskState
}

function makeMonitorMcpTask(): TaskState {
  return {
    id: 'm_monitor_1',
    type: 'monitor_mcp',
    status: 'running',
    description: 'external monitor',
    startTime: Date.now(),
    outputFile: '/tmp/monitor_1.output',
    outputOffset: 0,
    notified: false,
  } as TaskState
}

async function attachmentsFor(
  tasks: Record<string, TaskState>,
  agentId?: AgentId,
): Promise<AttachmentOf[]> {
  const result = await createBackgroundTaskAttachmentsIfNeeded(
    makeContext(tasks, agentId) as ToolUseContext,
  )
  return result.map(m => m.attachment as AttachmentOf)
}

describe('createBackgroundTaskAttachmentsIfNeeded', () => {
  test('re-announces a running backgrounded shell owned by the main thread', async () => {
    const out = await attachmentsFor({ b1: makeBashTask({ id: 'b1' }) })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'task_status',
      taskId: 'b1',
      taskType: 'local_bash',
      status: 'running',
      command: 'sleep 300',
      kind: 'bash',
    })
  })

  test('re-announces a running monitor-kind shell as kind monitor', async () => {
    const out = await attachmentsFor({
      b1: makeBashTask({ id: 'b1', kind: 'monitor' }),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ taskType: 'local_bash', kind: 'monitor' })
  })

  test('skips foreground shells — their tool_result is still pending', async () => {
    const out = await attachmentsFor({
      b1: makeBashTask({ id: 'b1', isBackgrounded: false }),
    })
    expect(out).toHaveLength(0)
  })

  test('skips terminal shell tasks — completion flows via task-notifications', async () => {
    const out = await attachmentsFor({
      b1: makeBashTask({ id: 'b1', status: 'completed' }),
    })
    expect(out).toHaveLength(0)
  })

  test('skips shells owned by another agent on a main-thread compact', async () => {
    const out = await attachmentsFor({
      b1: makeBashTask({ id: 'b1', agentId: 'a_sub_1' as AgentId }),
    })
    expect(out).toHaveLength(0)
  })

  test('skips main-owned shells on a subagent compact', async () => {
    const out = await attachmentsFor(
      { b1: makeBashTask({ id: 'b1' }) },
      'a_sub_1' as AgentId,
    )
    expect(out).toHaveLength(0)
  })

  test('re-announces a subagent-owned shell on that subagent compact', async () => {
    const out = await attachmentsFor(
      { b1: makeBashTask({ id: 'b1', agentId: 'a_sub_1' as AgentId }) },
      'a_sub_1' as AgentId,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ taskId: 'b1' })
  })

  test('re-announces a running background agent (regression guard)', async () => {
    const out = await attachmentsFor({
      a1: makeAgentTask({ id: 'a1', agentId: 'a_agent_1' }),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      taskId: 'a_agent_1',
      taskType: 'local_agent',
      status: 'running',
    })
  })

  test('re-announces a completed agent whose result is unretrieved', async () => {
    const out = await attachmentsFor({
      a1: makeAgentTask({
        id: 'a1',
        agentId: 'a_agent_1',
        status: 'completed',
        error: null,
      }),
    })
    expect(out).toHaveLength(1)
  })

  test('skips retrieved and pending agents', async () => {
    const out = await attachmentsFor({
      a1: makeAgentTask({ id: 'a1', agentId: 'a_agent_1', retrieved: true }),
      a2: makeAgentTask({
        id: 'a2',
        agentId: 'a_agent_2',
        status: 'pending',
      }),
    })
    expect(out).toHaveLength(0)
  })

  test('on a subagent compact, skips agents the subagent did not spawn', async () => {
    const own = makeAgentTask({
      id: 'own',
      agentId: 'a_own',
      parentAgentId: 'a_sub_1' as AgentId,
    })
    const foreign = makeAgentTask({
      id: 'foreign',
      agentId: 'a_foreign',
      parentAgentId: 'a_other' as AgentId,
    })
    const out = await attachmentsFor({ own, foreign }, 'a_sub_1' as AgentId)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ taskId: 'a_own' })
  })

  test('re-announces a running external monitor on a main-thread compact only', async () => {
    const main = await attachmentsFor({ m1: makeMonitorMcpTask() })
    expect(main).toHaveLength(1)
    expect(main[0]).toMatchObject({ taskType: 'monitor_mcp' })

    const sub = await attachmentsFor(
      { m1: makeMonitorMcpTask() },
      'a_sub_1' as AgentId,
    )
    expect(sub).toHaveLength(0)
  })

  test('never re-announces dream tasks', async () => {
    const dream = {
      id: 'd_dream_1',
      type: 'dream',
      status: 'running',
      description: 'dreaming',
      startTime: Date.now(),
      outputFile: '/tmp/dream.output',
      outputOffset: 0,
      notified: false,
    } as TaskState
    const out = await attachmentsFor({ d1: dream })
    expect(out).toHaveLength(0)
  })

  test('running shell re-announce renders the command and duplicate warning', () => {
    const messages = normalizeAttachmentForAPI({
      type: 'task_status',
      taskId: 'b1',
      taskType: 'local_bash',
      status: 'running',
      description: 'watch the build',
      deltaSummary: null,
      outputFilePath: '/tmp/b1.output',
      command: 'sleep 300',
      kind: 'bash',
    })
    const text = messages
      .map(m =>
        typeof m.message.content === 'string'
          ? m.message.content
          : JSON.stringify(m.message.content),
      )
      .join('\n')
    expect(text).toContain(
      'Background command "watch the build" (b1) is still running',
    )
    expect(text).toContain('Command: sleep 300')
    expect(text).toContain('Do NOT spawn a duplicate')
    expect(text).toContain('/tmp/b1.output')
  })

  test('running agent re-announce keeps the agent wording', () => {
    const messages = normalizeAttachmentForAPI({
      type: 'task_status',
      taskId: 'a_agent_1',
      taskType: 'local_agent',
      status: 'running',
      description: 'probe agent',
      deltaSummary: null,
      outputFilePath: '/tmp/a_agent_1.output',
    })
    const text = messages
      .map(m =>
        typeof m.message.content === 'string'
          ? m.message.content
          : JSON.stringify(m.message.content),
      )
      .join('\n')
    expect(text).toContain(
      'Background agent "probe agent" (a_agent_1) is still running',
    )
    expect(text).not.toContain('Command:')
  })
})
