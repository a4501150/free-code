import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import {
  getStaleTaskListAttachment,
  STALE_TASK_LIST_CONFIG,
  type StaleTaskListItem,
} from '../../src/utils/attachments.js'
import { getAttachmentSystemReminderBodies } from '../../src/utils/messages.js'
import { createTask } from '../../src/utils/tasks.js'
import type { Task } from '../../src/utils/taskSchemas.js'
import { TASK_UPDATE_TOOL_NAME } from '../../src/tools/TaskUpdateTool/constants.js'

const TASK_LIST_ID = 'stale-task-list-test'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'stale-task-list-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = TASK_LIST_ID
})

afterEach(async () => {
  delete process.env.FREECODE_CONFIG_DIR
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
  await rm(configDir, { recursive: true, force: true })
})

async function addTask(overrides: Partial<Omit<Task, 'id'>> = {}) {
  return createTask(TASK_LIST_ID, {
    subject: 'Wire the thing',
    description: 'Wire the thing up',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...overrides,
  })
}

function contextWithTaskUpdate(toolNames: string[] = [TASK_UPDATE_TOOL_NAME]) {
  return {
    options: {
      tools: toolNames.map(name => ({ name }) as Tool),
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => ({ toolPermissionContext: {} }),
  } as ToolUseContext
}

/**
 * One streamed response, split the way claude.ts splits it: one Message per
 * content block, all sharing `message.id`, each with its own uuid.
 */
function response(
  id: string,
  blocks: Array<Record<string, unknown>> = [{ type: 'text', text: 'ok' }],
): Message[] {
  return blocks.map(
    block =>
      ({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        requestId: `req_${id}`,
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [block],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }) as unknown as Message,
  )
}

function toolResult(): Message {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'done' }],
    },
  } as unknown as Message
}

function reminder(): Message {
  return {
    type: 'attachment',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: {
      type: 'stale_task_list',
      roundsSinceTaskWrite: STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE,
      openTasks: [],
    },
  } as unknown as Message
}

/** N distinct responses, each separated by a tool result the way a tool loop does. */
function rounds(count: number, idPrefix = 'msg'): Message[] {
  return Array.from({ length: count }, (_, i) => [
    ...response(`${idPrefix}_${i}`),
    toolResult(),
  ]).flat()
}

function taskWriteResponse(id = 'msg_write'): Message[] {
  return response(id, [
    { type: 'text', text: 'updating' },
    {
      type: 'tool_use',
      id: 'tu_write',
      name: TASK_UPDATE_TOOL_NAME,
      input: { taskId: '1', status: 'in_progress' },
    },
  ])
}

describe('stale task list attachment', () => {
  test('stays silent before the threshold', async () => {
    await addTask()
    const messages = [
      ...taskWriteResponse(),
      toolResult(),
      ...rounds(STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE - 1),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  test('fires once the threshold is crossed, naming the open tasks', async () => {
    await addTask({ subject: 'Wire the thing', status: 'in_progress' })
    const messages = [
      ...taskWriteResponse(),
      toolResult(),
      ...rounds(STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE),
    ]

    const result = await getStaleTaskListAttachment(
      messages,
      contextWithTaskUpdate(),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'stale_task_list',
      roundsSinceTaskWrite: STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE,
      openTasks: [
        { id: '1', subject: 'Wire the thing', status: 'in_progress' },
      ],
    })
  })

  // The bug that got the previous reminder deleted: streaming emits one
  // AssistantMessage per content block, so a response with text plus three
  // parallel tool calls must still count as a single round.
  test('counts a multi-block response as one round', async () => {
    await addTask()
    const blocks = [
      { type: 'text', text: 'working' },
      { type: 'tool_use', id: 'a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'b', name: 'Read', input: {} },
      { type: 'tool_use', id: 'c', name: 'Read', input: {} },
    ]
    const messages = [
      ...taskWriteResponse(),
      toolResult(),
      ...Array.from(
        { length: STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE - 1 },
        (_, i) => [...response(`msg_${i}`, blocks), toolResult()],
      ).flat(),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  // Bedrock and Gemini synthesize ids from Date.now(); two responses could
  // collide. An intervening tool result still separates them.
  test('separates same-id responses split by a tool result', async () => {
    await addTask()
    const messages = [
      ...taskWriteResponse(),
      toolResult(),
      ...Array.from(
        { length: STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE },
        () => [...response('msg_collision'), toolResult()],
      ).flat(),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toHaveLength(1)
  })

  test('a task write resets the count', async () => {
    await addTask()
    const messages = [
      ...rounds(STALE_TASK_LIST_CONFIG.ROUNDS_BETWEEN_REMINDERS, 'old'),
      ...taskWriteResponse(),
      toolResult(),
      ...rounds(2, 'new'),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  // The write block need not be the last block of its response. The response
  // that performed the write is round zero either way.
  test('a task write resets the count when trailed by another block', async () => {
    await addTask()
    const writeThenText = response('msg_write', [
      {
        type: 'tool_use',
        id: 'tu_write',
        name: TASK_UPDATE_TOOL_NAME,
        input: { taskId: '1', status: 'in_progress' },
      },
      { type: 'text', text: 'marked it' },
    ])
    const messages = [
      ...writeThenText,
      toolResult(),
      ...rounds(STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE - 1),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  test('does not repeat while the previous reminder is recent', async () => {
    await addTask()
    const messages = [
      reminder(),
      ...rounds(STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE + 1),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  test('re-arms after a task write following a reminder', async () => {
    await addTask()
    const messages = [
      reminder(),
      ...taskWriteResponse(),
      toolResult(),
      ...rounds(STALE_TASK_LIST_CONFIG.ROUNDS_SINCE_TASK_WRITE),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toHaveLength(1)
  })

  test('repeats once the reminder is older than the suppression window', async () => {
    await addTask()
    const messages = [
      reminder(),
      ...rounds(STALE_TASK_LIST_CONFIG.ROUNDS_BETWEEN_REMINDERS + 1),
    ]

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toHaveLength(1)
  })

  test('stays silent when there is no task list at all', async () => {
    const messages = rounds(STALE_TASK_LIST_CONFIG.ROUNDS_BETWEEN_REMINDERS + 1)

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  test('stays silent when every task is completed', async () => {
    await addTask({ status: 'completed' })
    const messages = rounds(STALE_TASK_LIST_CONFIG.ROUNDS_BETWEEN_REMINDERS + 1)

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  test('ignores internal tasks', async () => {
    await addTask({ metadata: { _internal: true } })
    const messages = rounds(STALE_TASK_LIST_CONFIG.ROUNDS_BETWEEN_REMINDERS + 1)

    expect(
      await getStaleTaskListAttachment(messages, contextWithTaskUpdate()),
    ).toEqual([])
  })

  test('drops blockers that are already completed', async () => {
    await addTask({ status: 'completed' })
    await addTask({ subject: 'Blocked work', blockedBy: ['1'] })
    const messages = rounds(STALE_TASK_LIST_CONFIG.ROUNDS_BETWEEN_REMINDERS + 1)

    const result = await getStaleTaskListAttachment(
      messages,
      contextWithTaskUpdate(),
    )

    expect(result).toHaveLength(1)
    expect((result[0] as { openTasks: StaleTaskListItem[] }).openTasks).toEqual(
      [{ id: '2', subject: 'Blocked work', status: 'pending', blockedBy: [] }],
    )
  })

  test('stays silent when TaskUpdate is unavailable', async () => {
    await addTask()
    const messages = rounds(STALE_TASK_LIST_CONFIG.ROUNDS_BETWEEN_REMINDERS + 1)

    expect(
      await getStaleTaskListAttachment(
        messages,
        contextWithTaskUpdate(['Read']),
      ),
    ).toEqual([])
  })

  // shouldHideAttachmentInUI keeps a no-summary-line attachment only when it
  // contributes a reminder body, so an empty body here would hide the row.
  test('materializes as a single system reminder', () => {
    const bodies = getAttachmentSystemReminderBodies({
      type: 'stale_task_list',
      roundsSinceTaskWrite: 12,
      openTasks: [
        {
          id: '1',
          subject: 'Wire the thing',
          status: 'in_progress',
          blockedBy: [],
        },
        {
          id: '2',
          subject: 'Test the thing',
          status: 'pending',
          blockedBy: ['1'],
        },
      ],
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('#1 [in_progress] Wire the thing')
    expect(bodies[0]).toContain('#2 [pending] Test the thing [blocked by #1]')
    expect(bodies[0]).toContain('One open task is currently marked in_progress')
  })

  test('does not call a task in_progress stale when none is', () => {
    const bodies = getAttachmentSystemReminderBodies({
      type: 'stale_task_list',
      roundsSinceTaskWrite: 12,
      openTasks: [
        {
          id: '1',
          subject: 'Wire the thing',
          status: 'pending',
          blockedBy: [],
        },
      ],
    })

    expect(bodies[0]).toContain('No open task is currently marked in_progress')
  })
})
