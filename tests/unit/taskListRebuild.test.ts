import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { switchSession } from '../../src/bootstrap/state.js'
import {
  clearTaskListIdOverride,
  createTask,
  getMainTaskListId,
  listTasks,
  setTaskListIdOverride,
} from '../../src/utils/tasks.js'
import { rebuildTaskListFromTranscript } from '../../src/utils/taskListRebuild.js'
import { asSessionId } from '../../src/types/ids.js'

let configDir: string
let transcriptPath: string

function assistantLine(
  uuid: string,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  isSidechain = false,
): string {
  return JSON.stringify({
    uuid,
    type: 'assistant',
    isSidechain,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input }],
    },
  })
}

function resultLine(
  uuid: string,
  toolUseId: string,
  toolUseResult: unknown,
  text: string,
  isSidechain = false,
): string {
  return JSON.stringify({
    uuid,
    type: 'user',
    isSidechain,
    toolUseResult,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
  })
}

function createPair(
  uuidBase: string,
  id: string,
  input: Record<string, unknown>,
): string[] {
  const toolUseId = `toolu_${uuidBase}`
  return [
    assistantLine(`a-${uuidBase}`, toolUseId, 'TaskCreate', input),
    resultLine(
      `u-${uuidBase}`,
      toolUseId,
      { task: { id, subject: input.subject } },
      `Task #${id} created successfully: ${input.subject}`,
    ),
  ]
}

function updatePair(
  uuidBase: string,
  input: Record<string, unknown>,
  success = true,
): string[] {
  const toolUseId = `toolu_${uuidBase}`
  return [
    assistantLine(`a-${uuidBase}`, toolUseId, 'TaskUpdate', input),
    resultLine(
      `u-${uuidBase}`,
      toolUseId,
      {
        success,
        taskId: input.taskId,
        updatedFields: success ? ['status'] : [],
        ...(success ? {} : { error: 'Task not found' }),
      },
      success ? `Updated task ${input.taskId}` : 'Task not found',
    ),
  ]
}

async function writeTranscript(lines: string[]): Promise<void> {
  await writeFile(transcriptPath, lines.join('\n') + '\n', 'utf-8')
}

/** Fresh session per test: the list dir is keyed by session id under configDir. */
function freshSession(): string {
  switchSession(asSessionId(randomUUID()), null)
  return getMainTaskListId()
}

let listId: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'tasklist-rebuild-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  transcriptPath = join(configDir, 'source-transcript.jsonl')
  listId = freshSession()
})

afterEach(async () => {
  clearTaskListIdOverride()
  delete process.env.FREECODE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

describe('rebuildTaskListFromTranscript', () => {
  test('replays creates and updates with final state', async () => {
    await writeTranscript([
      ...createPair('c1', '1', {
        subject: 'First',
        description: 'Do the first thing',
        activeForm: 'Doing the first thing',
      }),
      ...createPair('c2', '2', {
        subject: 'Second',
        description: 'Do the second thing',
      }),
      ...updatePair('u1', { taskId: '1', status: 'completed' }),
    ])

    const seeded = await rebuildTaskListFromTranscript(transcriptPath)
    expect(seeded).toBe(true)

    const tasks = await listTasks(listId)
    const byId = new Map(tasks.map(t => [t.id, t]))
    expect(byId.get('1')?.status).toBe('completed')
    expect(byId.get('1')?.subject).toBe('First')
    expect(byId.get('1')?.activeForm).toBe('Doing the first thing')
    expect(byId.get('2')?.status).toBe('pending')
    expect(byId.get('2')?.description).toBe('Do the second thing')
  })

  test('delete removes the task and strips block references', async () => {
    await writeTranscript([
      ...createPair('c1', '1', { subject: 'One', description: 'd' }),
      ...createPair('c2', '2', { subject: 'Two', description: 'd' }),
      ...createPair('c3', '3', { subject: 'Three', description: 'd' }),
      ...updatePair('u1', { taskId: '1', addBlocks: ['2', '3'] }),
      ...updatePair('u2', { taskId: '2', status: 'deleted' }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(true)

    const tasks = await listTasks(listId)
    const byId = new Map(tasks.map(t => [t.id, t]))
    expect([...byId.keys()].sort()).toEqual(['1', '3'])
    expect(byId.get('1')?.blocks).toEqual(['3'])
    expect(byId.get('3')?.blockedBy).toEqual(['1'])
  })

  test('replays task ops from before a compaction boundary', async () => {
    await writeTranscript([
      ...createPair('c1', '1', {
        subject: 'Pre-compact',
        description: 'created before the boundary',
      }),
      // Compact boundary: parentUuid nulled, logicalParentUuid keeps the chain.
      // The rebuild scans raw lines, so ops on both sides replay.
      JSON.stringify({
        uuid: 'boundary',
        type: 'assistant',
        isSidechain: false,
        parentUuid: null,
        logicalParentUuid: 'a-c1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Compacted summary' }],
        },
      }),
      ...updatePair('u1', { taskId: '1', status: 'in_progress' }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(true)

    const tasks = await listTasks(listId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.subject).toBe('Pre-compact')
    expect(tasks[0]?.status).toBe('in_progress')
  })

  test('ignores sidechain lines', async () => {
    await writeTranscript([
      createPair('c1', '1', { subject: 'Main', description: 'd' })[0]!,
      createPair('c1', '1', { subject: 'Main', description: 'd' })[1]!,
      // A subagent's task call: separate sidechain file in reality, but the
      // isSidechain flag must exclude it regardless of where it appears.
      assistantLine(
        'a-s1',
        'toolu_s1',
        'TaskCreate',
        { subject: 'Subagent task', description: 'd' },
        true,
      ),
      resultLine(
        'u-s1',
        'toolu_s1',
        { task: { id: '2', subject: 'Subagent task' } },
        'Task #2 created successfully: Subagent task',
        true,
      ),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(true)

    const tasks = await listTasks(listId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.subject).toBe('Main')
  })

  test('high-water mark continues the ID sequence after rebuild', async () => {
    await writeTranscript([
      ...createPair('c1', '1', { subject: 'One', description: 'd' }),
      ...createPair('c2', '2', { subject: 'Two', description: 'd' }),
    ])
    await rebuildTaskListFromTranscript(transcriptPath)

    const nextId = await createTask(listId, {
      subject: 'Post-resume',
      description: 'd',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    expect(nextId).toBe('3')
  })

  test('skips when the target list already has tasks on disk', async () => {
    await createTask(listId, {
      subject: 'Live task',
      description: 'd',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    await writeTranscript([
      ...createPair('c1', '1', { subject: 'One', description: 'd' }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(false)
    const tasks = await listTasks(listId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.subject).toBe('Live task')
  })

  test('never replays into an override (tasks-mode) list', async () => {
    setTaskListIdOverride(listId)
    await writeTranscript([
      ...createPair('c1', '1', { subject: 'One', description: 'd' }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(false)
    expect(await listTasks(listId)).toHaveLength(0)
  })

  test('resurrects a fully-completed list faithfully', async () => {
    await writeTranscript([
      ...createPair('c1', '1', { subject: 'Only', description: 'd' }),
      ...updatePair('u1', { taskId: '1', status: 'completed' }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(true)
    const tasks = await listTasks(listId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.status).toBe('completed')
  })

  test('metadata merge honors null-deletes', async () => {
    await writeTranscript([
      ...createPair('c1', '1', {
        subject: 'One',
        description: 'd',
        metadata: { keep: 'yes', drop: 'no' },
      }),
      ...updatePair('u1', {
        taskId: '1',
        metadata: { drop: null, added: 'new' },
      }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(true)
    const tasks = await listTasks(listId)
    expect(tasks[0]?.metadata).toEqual({ keep: 'yes', added: 'new' })
  })

  test('dedupes re-recorded lines (compaction kept-copies) by uuid', async () => {
    const [use, result] = createPair('c1', '1', {
      subject: 'One',
      description: 'd',
    })
    const [updateUse, updateResult] = updatePair('u1', {
      taskId: '1',
      addBlocks: ['2'],
    })
    await writeTranscript([
      ...createPair('c2', '2', { subject: 'Two', description: 'd' }),
      use,
      result,
      // Kept-message copies re-recorded after the compact boundary.
      use,
      result,
      updateUse,
      updateResult,
      // And again after a rewind-style same-head shrink.
      updateUse,
      updateResult,
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(true)
    const tasks = await listTasks(listId)
    const byId = new Map(tasks.map(t => [t.id, t]))
    expect(byId.get('1')?.blocks).toEqual(['2'])
    expect(byId.get('2')?.blockedBy).toEqual(['1'])
  })

  test('skips creates without a recorded result (cannot know the ID)', async () => {
    await writeTranscript([
      assistantLine('a-c1', 'toolu_c1', 'TaskCreate', {
        subject: 'Lost result',
        description: 'd',
      }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(false)
    expect(await listTasks(listId)).toHaveLength(0)
  })

  test('skips updates the tool reported failed', async () => {
    await writeTranscript([
      ...createPair('c1', '1', { subject: 'One', description: 'd' }),
      ...updatePair('u1', { taskId: '9', status: 'completed' }, false),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(true)
    const tasks = await listTasks(listId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.status).toBe('pending')
  })

  test('returns false when the transcript has no task ops', async () => {
    await writeTranscript([
      JSON.stringify({
        uuid: 'a-1',
        type: 'assistant',
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    ])

    expect(await rebuildTaskListFromTranscript(transcriptPath)).toBe(false)
    expect(await listTasks(listId)).toHaveLength(0)
  })
})
