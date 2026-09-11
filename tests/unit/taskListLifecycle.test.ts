import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getSessionId,
  regenerateSessionId,
  switchSession,
} from '../../src/bootstrap/state.js'
import {
  cleanupSessionTaskList,
  gcStaleTaskLists,
  getMainTaskListId,
  getTasksDir,
} from '../../src/utils/tasks.js'
import { asSessionId } from '../../src/types/ids.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

let configDir: string
let previousConfigDir: string | undefined

async function seedList(taskListId: string): Promise<void> {
  const dir = getTasksDir(taskListId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '1.json'), '{}')
}

async function exists(taskListId: string): Promise<boolean> {
  try {
    return (await stat(getTasksDir(taskListId))).isDirectory()
  } catch {
    return false
  }
}

async function ageDir(taskListId: string, days: number): Promise<void> {
  const at = (Date.now() - days * 24 * 3600_000) / 1000
  await utimes(getTasksDir(taskListId), at, at)
}

beforeEach(async () => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'tasklist-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.FREECODE_CONFIG_DIR
  else process.env.FREECODE_CONFIG_DIR = previousConfigDir
})

test('exit cleanup removes the session list this process owned', async () => {
  // Ownership is registered lazily by getMainTaskListId()'s session fallback.
  expect(getMainTaskListId()).toBe(getSessionId())
  await seedList(getSessionId())
  await seedList('other-session-list')

  await cleanupSessionTaskList()

  expect(await exists(getSessionId())).toBe(false)
  expect(await exists('other-session-list')).toBe(true)
})

test('exit cleanup removes lists orphaned by /clear and /resume', async () => {
  const firstId = getSessionId()
  // Session id is process-global test state; hand back what we borrowed.
  try {
    expect(getMainTaskListId()).toBe(firstId)
    await seedList(firstId)

    // /clear rotates the ID mid-process: the old list is orphaned but still
    // owned by this process.
    const secondId = regenerateSessionId() as string
    expect(getMainTaskListId()).toBe(secondId)
    await seedList(secondId)

    // /resume adopts a third ID without a process exit in between.
    const resumedId = 'ffff0000-0000-4000-8000-000000000001'
    switchSession(asSessionId(resumedId))
    expect(getMainTaskListId()).toBe(resumedId)
    await seedList(resumedId)

    await cleanupSessionTaskList()

    expect(await exists(firstId)).toBe(false)
    expect(await exists(secondId)).toBe(false)
    expect(await exists(resumedId)).toBe(false)
  } finally {
    switchSession(firstId)
  }
})

test('gcStaleTaskLists deletes untouched lists older than a week', async () => {
  await seedList('old-session-a')
  await seedList('fresh-session-b')
  await seedList(getSessionId())
  await ageDir('old-session-a', 8)

  await gcStaleTaskLists()

  const names = await readdir(join(configDir, 'tasks'))
  expect(names).not.toContain('old-session-a')
  expect(names).toContain('fresh-session-b')
  expect(names).toContain(getSessionId())
})
