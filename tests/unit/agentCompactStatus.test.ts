import { describe, expect, test } from 'bun:test'
import { compactProgressLabel } from '../../src/services/compact/compactProgressLabel.js'
import {
  type LocalAgentTaskState,
  updateAgentCompactStatus,
} from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from '../../src/state/AppStateStore.js'

function agentTask(
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: 'agent-1',
    type: 'local_agent',
    status: 'running',
    description: 'Explore',
    startTime: 0,
    agentId: 'agent-1',
    prompt: 'go',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: false,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as LocalAgentTaskState
}

/** Minimal store stand-in: applies the updater and hands back the new tasks map. */
function withTask(task: LocalAgentTaskState) {
  let state = { tasks: { [task.id]: task } } as unknown as AppState
  return {
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
    get: () => state.tasks[task.id] as LocalAgentTaskState,
  }
}

describe('compactProgressLabel', () => {
  test('maps every event to a spinner verb with no trailing ellipsis', () => {
    expect(
      compactProgressLabel({ type: 'hooks_start', hookType: 'pre_compact' }),
    ).toBe('Running PreCompact hooks')
    expect(
      compactProgressLabel({ type: 'hooks_start', hookType: 'post_compact' }),
    ).toBe('Running PostCompact hooks')
    expect(
      compactProgressLabel({ type: 'hooks_start', hookType: 'session_start' }),
    ).toBe('Running SessionStart hooks')
    expect(compactProgressLabel({ type: 'compact_start' })).toBe(
      'Compacting conversation',
    )
    expect(compactProgressLabel({ type: 'compact_end' })).toBeNull()
  })
})

describe('updateAgentCompactStatus', () => {
  test('records label/startedAt/hooksActive and clears on compact_end', () => {
    const store = withTask(agentTask())

    updateAgentCompactStatus(
      'agent-1',
      { type: 'hooks_start', hookType: 'pre_compact' },
      store.setAppState,
    )
    let compacting = store.get().compacting
    expect(compacting?.label).toBe('Running PreCompact hooks')
    expect(compacting?.hooksActive).toBe(true)
    expect(compacting?.startedAt).toBeGreaterThan(0)
    const startedAt = compacting?.startedAt

    updateAgentCompactStatus(
      'agent-1',
      { type: 'compact_start' },
      store.setAppState,
    )
    compacting = store.get().compacting
    expect(compacting?.label).toBe('Compacting conversation')
    expect(compacting?.hooksActive).toBe(false)
    // The progress bar stamps from the FIRST in-flight event, not the latest.
    expect(compacting?.startedAt).toBe(startedAt)

    updateAgentCompactStatus(
      'agent-1',
      { type: 'compact_end' },
      store.setAppState,
    )
    expect(store.get().compacting).toBeUndefined()
  })

  test('ignores updates for tasks that are no longer running', () => {
    const store = withTask(agentTask({ status: 'completed' }))
    updateAgentCompactStatus(
      'agent-1',
      { type: 'compact_start' },
      store.setAppState,
    )
    expect(store.get().compacting).toBeUndefined()
  })
})
