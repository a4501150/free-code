import { describe, expect, test } from 'bun:test'
import { IDLE_SPECULATION_STATE } from '../../src/state/AppStateStore.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import { markTaskEndedByUser, stopTask } from '../../src/tasks/stopTask.js'
import { dequeueAllMatching } from '../../src/utils/messageQueueManager.js'

function shellTask(): LocalShellTaskState {
  return {
    id: 'b1userkill',
    type: 'local_bash',
    status: 'running',
    description: 'dev server',
    startTime: 1,
    endTime: undefined,
    outputFile: '/tmp/b1userkill.output',
    command: 'npm run dev',
    result: undefined,
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    notified: false,
    kind: 'bash',
  } as unknown as LocalShellTaskState
}

function makeHarness() {
  let state = {
    speculation: IDLE_SPECULATION_STATE,
    tasks: { b1userkill: shellTask() },
  } as unknown as AppState
  const setAppState = (f: (prev: AppState) => AppState) => {
    state = f(state)
  }
  return {
    getAppState: () => state,
    setAppState,
    get task(): LocalShellTaskState {
      return state.tasks!.b1userkill as LocalShellTaskState
    },
  }
}

function drainNotifications(): string[] {
  return dequeueAllMatching(cmd => cmd.mode === 'task-notification').map(cmd =>
    String(cmd.value),
  )
}

describe('user-ended kill notifications', () => {
  test('stopTask with byUser stamps the flag and says so in the notification', async () => {
    dequeueAllMatching(() => true)
    const harness = makeHarness()
    await stopTask('b1userkill', harness, { byUser: true })
    expect(harness.task.status).toBe('killed')
    expect(harness.task.endedByUser).toBe(true)
    const notices = drainNotifications()
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('was stopped by the user')
  })

  test('stopTask without byUser keeps the plain stopped wording', async () => {
    dequeueAllMatching(() => true)
    const harness = makeHarness()
    await stopTask('b1userkill', harness)
    expect(harness.task.status).toBe('killed')
    expect(harness.task.endedByUser).toBeUndefined()
    const notices = drainNotifications()
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('"dev server" was stopped')
    expect(notices[0]).not.toContain('by the user')
  })

  test('markTaskEndedByUser stamps a running task so Task.kill paths inherit it', async () => {
    dequeueAllMatching(() => true)
    const harness = makeHarness()
    markTaskEndedByUser('b1userkill', harness.setAppState)
    expect(harness.task.endedByUser).toBe(true)
    // The TUI dialog kills through Task.kill after stamping; the flag must
    // survive into the notification.
    await stopTask('b1userkill', harness)
    const notices = drainNotifications()
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('was stopped by the user')
  })
})
