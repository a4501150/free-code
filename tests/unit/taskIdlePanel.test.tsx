import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as React from 'react'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskIdlePanel } from '../../src/components/TaskLivePanel.js'
import { AppStateProvider } from '../../src/state/AppState.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import type { Task } from '../../src/utils/tasks.js'
import { createTask, getMainTaskListId } from '../../src/utils/tasks.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'
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
  configDir = await mkdtemp(join(tmpdir(), 'idle-panel-'))
  process.env.FREECODE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.FREECODE_CONFIG_DIR
  else process.env.FREECODE_CONFIG_DIR = previousConfigDir
})

function taskData(
  subject: string,
  status: Task['status'],
): Omit<Task, 'id' | 'activeForm'> {
  return {
    subject,
    description: `${subject} body`,
    status,
    blocks: [],
    blockedBy: [],
  }
}

async function seed(...tasks: [Omit<Task, 'id'>, ...Omit<Task, 'id'>[]]) {
  for (const t of tasks) await createTask(getMainTaskListId(), t)
}

function plainText(frame: string): string {
  return frame.replace(/\x1b\[[0-9;]*m/g, '')
}

async function renderPanel(): Promise<string> {
  const frame = await renderToAnsiString(
    <AppStateProvider
      initialState={{ ...getDefaultAppState(), expandedView: 'tasks' }}
    >
      <TaskIdlePanel />
    </AppStateProvider>,
  )
  return frame
}

test('header line renders with counts when expanded', async () => {
  await seed(taskData('Alpha', 'completed'), taskData('Beta', 'pending'))
  await renderPanel() // start the store; snapshot is undefined on the first frame
  await new Promise(resolve => setTimeout(resolve, 200))
  const frame = plainText(await renderPanel())

  expect(frame).toContain('2 tasks (1 done, 1 open)')
  // In-progress segment is omitted at zero.
  expect(frame).not.toContain('in progress')
  // Row icons: completed tick + pending empty square, no filled square.
  expect(frame).toContain('✔ Alpha')
  expect(frame).toContain('◻ Beta')
  expect(frame).not.toContain('◼')
})

test('in-progress segment appears when a task is in progress', async () => {
  await seed(taskData('Beta', 'in_progress'), taskData('Gamma', 'pending'))
  await renderPanel()
  await new Promise(resolve => setTimeout(resolve, 200))
  const frame = plainText(await renderPanel())

  expect(frame).toContain('2 tasks (0 done, 1 in progress, 1 open)')
})

test('renders nothing when the panel is collapsed', async () => {
  await seed(taskData('Alpha', 'pending'))
  const frame = await renderToAnsiString(
    <AppStateProvider initialState={getDefaultAppState()}>
      <TaskIdlePanel />
    </AppStateProvider>,
  )

  expect(plainText(frame)).not.toContain('tasks (')
})

test('renders nothing when the list is empty', async () => {
  await renderPanel()
  await new Promise(resolve => setTimeout(resolve, 200))
  const frame = await renderPanel()

  expect(plainText(frame)).not.toContain('tasks (')
})
