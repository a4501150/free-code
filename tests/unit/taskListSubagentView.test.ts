import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TaskGetTool } from '../../src/tools/TaskGetTool/TaskGetTool.js'
import { TaskListTool } from '../../src/tools/TaskListTool/TaskListTool.js'
import { runWithAgentContext } from '../../src/utils/agentContext.js'
import { createTask, getMainTaskListId } from '../../src/utils/tasks.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

let configDir: string
let previousConfigDir: string | undefined

const subagentCtx = { agentType: 'subagent' as const, agentId: 'agent-1' }

function taskData(subject: string, extra = {}) {
  return {
    subject,
    description: `${subject} description`,
    status: 'pending' as const,
    blocks: [],
    blockedBy: [],
    ...extra,
  }
}

async function callList() {
  const { data } = await TaskListTool.call(
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
  )
  return data
}

function renderList(data: Awaited<ReturnType<typeof callList>>) {
  const block = TaskListTool.mapToolResultToToolResultBlockParam(
    data,
    'toolu-test',
  )
  return typeof block.content === 'string' ? block.content : ''
}

beforeEach(async () => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'tasklist-view-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.FREECODE_CONFIG_DIR
  else process.env.FREECODE_CONFIG_DIR = previousConfigDir
})

test('main session TaskList shows only its own list', async () => {
  await createTask(getMainTaskListId(), taskData('parent task'))

  const data = await callList()
  expect(data.tasks).toEqual([
    { id: '1', subject: 'parent task', status: 'pending', blockedBy: [] },
  ])
  expect(renderList(data)).toContain('parent task')
})

test('subagent TaskList appends the parent list as read-only rows', async () => {
  await createTask(`subagent-agent-1`, taskData('own task'))
  await createTask(getMainTaskListId(), taskData('parent task'))

  const data = await runWithAgentContext(subagentCtx, callList)
  const own = data.tasks.find(t => !t.fromParent)
  const parent = data.tasks.find(t => t.fromParent)
  expect(own?.subject).toBe('own task')
  expect(parent?.subject).toBe('parent task')

  const text = renderList(data)
  expect(text).toContain('Your task list:')
  expect(text).toContain("Parent session's task list (read-only")
  expect(text).toContain('own task')
  expect(text).toContain('parent task')
})

test('blockedBy resolves per list, not across parent and subagent', async () => {
  // The subagent's own #1 is completed and clears its own blockedBy; the
  // parent's #2 is still blocked by the parent's pending #1 even though the
  // IDs collide.
  await createTask(
    `subagent-agent-1`,
    taskData('own done', { status: 'completed' }),
  )
  await createTask(
    `subagent-agent-1`,
    taskData('own blocked', { blockedBy: ['1'] }),
  )
  await createTask(getMainTaskListId(), taskData('parent open'))
  await createTask(
    getMainTaskListId(),
    taskData('parent blocked', { blockedBy: ['1'] }),
  )

  const data = await runWithAgentContext(subagentCtx, callList)
  const ownBlocked = data.tasks.find(
    t => !t.fromParent && t.subject === 'own blocked',
  )
  const parentBlocked = data.tasks.find(
    t => t.fromParent && t.subject === 'parent blocked',
  )
  expect(ownBlocked?.blockedBy).toEqual([])
  expect(parentBlocked?.blockedBy).toEqual(['1'])
})

test('subagent TaskGet falls back to the parent list read-only', async () => {
  await createTask(`subagent-agent-1`, taskData('own task'))
  await createTask(getMainTaskListId(), taskData('parent task'))
  await createTask(getMainTaskListId(), taskData('parent task 2'))

  const ownOnly = await runWithAgentContext(subagentCtx, () => getTask('1'))
  // Own list wins over the parent list for colliding IDs.
  expect(ownOnly.data.task?.subject).toBe('own task')
  expect(ownOnly.data.task?.fromParent).toBeUndefined()

  const parent = await runWithAgentContext(subagentCtx, () => getTask('2'))
  expect(parent.data.task?.subject).toBe('parent task 2')
  expect(parent.data.task?.fromParent).toBe(true)
  const block = TaskGetTool.mapToolResultToToolResultBlockParam(
    parent.data,
    'toolu-test',
  )
  expect(block.content).toContain('read-only')

  const missing = await runWithAgentContext(subagentCtx, () => getTask('999'))
  expect(missing.data.task).toBeNull()
})

function getTask(taskId: string) {
  return TaskGetTool.call(
    { taskId } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
  )
}

test('subagent with an empty parent list keeps the plain output', async () => {
  await createTask(`subagent-agent-1`, taskData('own task'))

  const data = await runWithAgentContext(subagentCtx, callList)
  expect(data.tasks.map(t => t.subject)).toEqual(['own task'])
  expect(renderList(data)).toBe('#1 [pending] own task')
})
