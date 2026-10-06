import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { SetAppState } from '../../src/Task.js'
import type { Monitor } from '../../src/utils/monitors.js'
import { getMonitorManager } from '../../src/utils/monitors.js'
import { isLocalShellTask } from '../../src/tasks/LocalShellTask/guards.js'
import { killTask } from '../../src/tasks/LocalShellTask/killShellTasks.js'
import {
  mirrorMonitorStatus,
  monitorStatusToTaskStatus,
  registerMonitorTaskState,
} from '../../src/tasks/MonitorTask/taskState.js'

// ---------------------------------------------------------------------------
// Monitor mirror tests. registerTask/updateTaskState only touch
// prev.tasks, so a minimal fake store suffices — no mock.module (unit
// tests share one process, see AGENTS.md). Disk buffers are never
// written in these tests: appends only drain when the entry exists and
// the terminal paths flush an empty buffer, which is a no-op.
// ---------------------------------------------------------------------------

function makeStore(): { state: AppState; setAppState: SetAppState } {
  const state = { tasks: {} } as AppState
  const setAppState: SetAppState = f => {
    const next = f(state)
    if (next !== state) {
      for (const key of Object.keys(next)) {
        ;(state as Record<string, unknown>)[key] = (
          next as Record<string, unknown>
        )[key]
      }
    }
  }
  return { state, setAppState }
}

function makeMonitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 'mon_1_test',
    label: 'app-log-tail',
    command: 'tail -f app.log',
    status: 'running',
    output: [],
    newOutput: [],
    hasUnnotifiedOutput: false,
    startedAt: 1000,
    ...overrides,
  }
}

function getTask(state: AppState, id: string): LocalShellTaskState {
  return state.tasks[id] as LocalShellTaskState
}

describe('monitorStatusToTaskStatus', () => {
  test('maps monitor statuses onto the TaskStatus vocabulary', () => {
    expect(monitorStatusToTaskStatus(makeMonitor())).toBe('running')
    expect(monitorStatusToTaskStatus(makeMonitor({ status: 'exited' }))).toBe(
      'completed',
    )
    expect(monitorStatusToTaskStatus(makeMonitor({ status: 'error' }))).toBe(
      'failed',
    )
    expect(monitorStatusToTaskStatus(makeMonitor({ status: 'stopped' }))).toBe(
      'killed',
    )
  })
})

describe('registerMonitorTaskState', () => {
  test('registers a running mirror with the monitor-kind display variant', () => {
    const { state, setAppState } = makeStore()
    registerMonitorTaskState(makeMonitor(), setAppState)
    const task = getTask(state, 'mon_1_test')
    expect(isLocalShellTask(task)).toBe(true)
    expect(task.type).toBe('local_bash')
    expect(task.kind).toBe('monitor')
    expect(task.status).toBe('running')
    expect(task.isBackgrounded).toBe(true)
    expect(task.shellCommand).toBeNull()
    expect(task.description).toBe('app-log-tail')
    expect(task.command).toBe('tail -f app.log')
  })

  test('registers a terminal mirror when the spawn already failed', () => {
    const { state, setAppState } = makeStore()
    registerMonitorTaskState(
      makeMonitor({ status: 'error', exitCode: 1 }),
      setAppState,
    )
    const task = getTask(state, 'mon_1_test')
    expect(task.status).toBe('failed')
    expect(task.notified).toBe(true)
    expect(task.result?.code).toBe(1)
  })
})

describe('mirrorMonitorStatus', () => {
  test('transitions a running mirror to killed on stop', () => {
    const { state, setAppState } = makeStore()
    registerMonitorTaskState(makeMonitor(), setAppState)
    mirrorMonitorStatus(makeMonitor({ status: 'stopped' }), setAppState)
    const task = getTask(state, 'mon_1_test')
    expect(task.status).toBe('killed')
    expect(task.notified).toBe(true)
    expect(typeof task.endTime).toBe('number')
  })

  test('is a no-op for a running monitor and for an already-terminal mirror', () => {
    const { state, setAppState } = makeStore()
    registerMonitorTaskState(makeMonitor(), setAppState)
    const before = getTask(state, 'mon_1_test')
    mirrorMonitorStatus(makeMonitor({ id: 'mon_1_test' }), setAppState)
    expect(getTask(state, 'mon_1_test')).toBe(before)

    mirrorMonitorStatus(makeMonitor({ status: 'stopped' }), setAppState)
    const killed = getTask(state, 'mon_1_test')
    mirrorMonitorStatus(makeMonitor({ status: 'stopped' }), setAppState)
    expect(getTask(state, 'mon_1_test')).toBe(killed)
  })
})

describe('killTask monitor branch', () => {
  test('marks an unknown monitor mirror killed without a shell kill', () => {
    const { state, setAppState } = makeStore()
    // The monitor id is not registered in the manager singleton, so
    // manager.stop fails and killTask falls back to marking the mirror
    // killed — it must not ghost as running in the dialog.
    registerMonitorTaskState(makeMonitor({ id: 'mon_9_orphan' }), setAppState)
    expect(getTask(state, 'mon_9_orphan').status).toBe('running')

    killTask('mon_9_orphan', setAppState)

    const task = getTask(state, 'mon_9_orphan')
    expect(task.status).toBe('killed')
    expect(task.notified).toBe(true)
  })

  test('is a no-op when the task is already terminal', () => {
    const { state, setAppState } = makeStore()
    registerMonitorTaskState(makeMonitor(), setAppState)
    // A running plain shell task would be killed via its ShellCommand; the
    // guard this exercises is the monitor branch not hijacking other kinds —
    // here a task that is not a monitor-kind mirror falls through untouched
    // when already terminal.
    mirrorMonitorStatus(makeMonitor({ status: 'stopped' }), setAppState)
    const killed = getTask(state, 'mon_1_test')
    killTask('mon_1_test', setAppState)
    expect(getTask(state, 'mon_1_test')).toBe(killed)
  })
})

describe('getMonitorManager singleton', () => {
  test('manager.stop returns false for a monitor it does not know', () => {
    expect(getMonitorManager().stop('mon_missing')).toBe(false)
  })
})
