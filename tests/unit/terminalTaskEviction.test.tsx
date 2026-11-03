import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as React from 'react'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { useTerminalTaskEviction } from '../../src/hooks/useTerminalTaskEviction.js'
import { render } from '../../src/ink.js'
import { AppStateProvider, useAppState } from '../../src/state/AppState.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { makeLocalAgentTask } from '../helpers/taskFixtures.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'task-eviction-'))
  process.env.FREECODE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.FREECODE_CONFIG_DIR
  else process.env.FREECODE_CONFIG_DIR = previousConfigDir
})

// Ink needs columns/rows/isTTY at construction; a PassThrough provides
// write/on for everything else it touches outside a real terminal.
function fakeStdout(): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  Object.assign(stream, { columns: 80, rows: 24, isTTY: true })
  return stream
}

function Probe({ onTasks }: { onTasks: (ids: string[]) => void }): null {
  useTerminalTaskEviction()
  const tasks = useAppState(s => s.tasks)
  onTasks(Object.keys(tasks ?? {}))
  return null
}

test('hook evicts expired terminal tasks without the coordinator panel mounted', async () => {
  const now = Date.now()
  const initialState = {
    ...getDefaultAppState(),
    tasks: {
      // Terminal + notified + evictAfter in the past — evictable.
      expired: makeLocalAgentTask({
        id: 'expired',
        status: 'completed',
        notified: true,
        evictAfter: now - 1000,
      }),
      // Terminal + notified but retained (user is viewing the drill-down).
      viewed: makeLocalAgentTask({
        id: 'viewed',
        status: 'completed',
        notified: true,
        retain: true,
      }),
      // Terminal but the completion notification has not been delivered yet.
      unnotified: makeLocalAgentTask({
        id: 'unnotified',
        status: 'completed',
        notified: false,
        evictAfter: now - 1000,
      }),
      // Still running.
      running: makeLocalAgentTask({ id: 'running', status: 'running' }),
    },
  }

  const seen: string[] = []
  const instance = await render(
    <AppStateProvider initialState={initialState}>
      <Probe onTasks={ids => seen.splice(0, seen.length, ...ids)} />
    </AppStateProvider>,
    { stdout: fakeStdout(), patchConsole: false, exitOnCtrlC: false },
  )

  try {
    // Initial render sees everything; the 1s eviction tick must remove only
    // the expired entry.
    expect(seen).toContain('expired')
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect(seen).not.toContain('expired')
    expect(seen).toContain('viewed')
    expect(seen).toContain('unnotified')
    expect(seen).toContain('running')
  } finally {
    instance.unmount()
  }
})
