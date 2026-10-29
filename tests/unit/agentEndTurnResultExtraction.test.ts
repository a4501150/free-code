/**
 * EndTurn completion must not leak into the collected agent response.
 *
 * The strict end_turn model ends a subagent run with a final assistant
 * message that carries an EndTurn tool_use block (alone or alongside the
 * result text), plus its tool_result. Every surface that collects "the
 * agent's response" — finalizeAgentTool's content, the parent tool_result,
 * the async completion notification, partial results after a kill — must
 * extract TEXT BLOCKS ONLY, so the internal EndTurn call never reaches the
 * parent model as response content. These tests pin that invariant.
 *
 * They also pin the post-nudge skip: text the agent emits in reply to the
 * end-turn reminder (an ack or a restatement, with no real work after the
 * nudge) must NOT become the delivered result — the report from before the
 * nudge is. Real work after the nudge, and replies to the owned-tasks
 * reminder, are genuine output and last-wins stands.
 *
 * AgentTool.js is imported first: agentToolUtils sits in a module cycle
 * (agentToolUtils → LocalAgentTask → ... → AgentTool.tsx) where loading
 * agentToolUtils first hits a TDZ on agentToolResultSchema at AgentTool.tsx
 * module-init time.
 */
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import '../../src/tools/AgentTool/AgentTool.js'
import {
  extractPartialResult,
  finalizeAgentTool,
} from '../../src/tools/AgentTool/agentToolUtils.js'
import { createProgressTracker } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import {
  END_TURN_REMINDER,
  END_TURN_REMINDER_TAG,
  END_TURN_TOOL_NAME,
} from '../../src/tools/EndTurnTool/constants.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../src/types/message.js'

function assistantMessage(
  blocks: Array<Record<string, unknown>>,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    parentUuid: null,
    sessionId: 'test',
    requestId: randomUUID(),
    message: {
      id: randomUUID(),
      role: 'assistant',
      model: 'test-model',
      content: blocks,
      stop_reason: 'tool_use',
      type: 'message',
    },
  } as unknown as AssistantMessage
}

function userToolResult(toolUseId: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    parentUuid: null,
    sessionId: 'test',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'Run ended' },
      ],
    },
  } as unknown as UserMessage
}

function endTurnBlock(id: string) {
  return { type: 'tool_use', id, name: END_TURN_TOOL_NAME, input: {} }
}

function endReminderUserMessage(): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    parentUuid: null,
    sessionId: 'test',
    isMeta: true,
    message: {
      role: 'user',
      content: END_TURN_REMINDER,
    },
  } as unknown as UserMessage
}

function ownedTasksReminderUserMessage(): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    parentUuid: null,
    sessionId: 'test',
    isMeta: true,
    message: {
      role: 'user',
      content: `<${END_TURN_REMINDER_TAG}>\nYou ended your message while still owning 1 running background task(s):\n- t1 (background): npm test\n</${END_TURN_REMINDER_TAG}>`,
    },
  } as unknown as UserMessage
}

function finalize(messages: Message[]) {
  return finalizeAgentTool(
    messages,
    'a_probe',
    {
      prompt: 'probe',
      resolvedAgentModel: 'test-model',
      isBuiltInAgent: false,
      startTime: Date.now(),
      agentType: 'general-purpose',
      isAsync: false,
    },
    createProgressTracker(),
  )
}

describe('EndTurn does not leak into the agent response', () => {
  test('text + EndTurn in the same final assistant message: content is text only', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      assistantMessage([
        { type: 'text', text: 'Done, all fixed.' },
        endTurnBlock(endTurnId),
      ]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([{ type: 'text', text: 'Done, all fixed.' }])
    expect(JSON.stringify(result.content)).not.toContain(END_TURN_TOOL_NAME)
    // The completion call is protocol, not work: it must not count as a
    // tool use in the <usage> trailer or the "Done (N tool uses)" line.
    expect(result.totalToolUseCount).toBe(0)
    // stop_reason 'tool_use' from the EndTurn round must not read as an
    // error stop in the parent tool_result.
    expect(result.errorReason).toBeUndefined()
  })

  test('EndTurn-only final message: falls back to the last assistant text', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      assistantMessage([{ type: 'text', text: 'Investigated the bug.' }]),
      assistantMessage([endTurnBlock(endTurnId)]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([
      { type: 'text', text: 'Investigated the bug.' },
    ])
    expect(JSON.stringify(result.content)).not.toContain(END_TURN_TOOL_NAME)
  })

  test('real tool calls still count; EndTurn never does', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      assistantMessage([
        { type: 'text', text: 'Working.' },
        { type: 'tool_use', id: randomUUID(), name: 'Bash', input: {} },
      ]),
      assistantMessage([endTurnBlock(endTurnId)]),
      userToolResult(endTurnId),
    ])

    expect(result.totalToolUseCount).toBe(1)
  })

  test('partial-result extraction after a kill is text only', () => {
    const endTurnId = randomUUID()
    const partial = extractPartialResult([
      assistantMessage([
        { type: 'text', text: 'Partial findings so far.' },
        endTurnBlock(endTurnId),
      ]),
      userToolResult(endTurnId),
    ])

    expect(partial).toBe('Partial findings so far.')
  })
})

describe('post-nudge ack text does not become the result', () => {
  test('restatement in reply to the nudge: original report wins', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      assistantMessage([
        {
          type: 'text',
          text: 'Full report: seven areas, with file:line cites.',
        },
      ]),
      endReminderUserMessage(),
      assistantMessage([
        {
          type: 'text',
          text: 'Restatement: the report again, shorter and worse.',
        },
        endTurnBlock(endTurnId),
      ]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([
      { type: 'text', text: 'Full report: seven areas, with file:line cites.' },
    ])
  })

  test('brief ack in reply to the nudge: original report wins', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      assistantMessage([{ type: 'text', text: 'The diagnosis and the fix.' }]),
      endReminderUserMessage(),
      assistantMessage([
        { type: 'text', text: 'Understood — ending now.' },
        endTurnBlock(endTurnId),
      ]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([
      { type: 'text', text: 'The diagnosis and the fix.' },
    ])
  })

  test('EndTurn-only reply to the nudge: original report wins', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      assistantMessage([{ type: 'text', text: 'Report before the nudge.' }]),
      endReminderUserMessage(),
      assistantMessage([endTurnBlock(endTurnId)]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([
      { type: 'text', text: 'Report before the nudge.' },
    ])
  })

  test('real work after the nudge: new trailing text wins', () => {
    const endTurnId = randomUUID()
    const bashId = randomUUID()
    const result = finalize([
      assistantMessage([{ type: 'text', text: 'First report.' }]),
      endReminderUserMessage(),
      assistantMessage([
        { type: 'tool_use', id: bashId, name: 'Bash', input: {} },
      ]),
      userToolResult(bashId),
      assistantMessage([
        { type: 'text', text: 'Second report after finishing the extra work.' },
        endTurnBlock(endTurnId),
      ]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([
      { type: 'text', text: 'Second report after finishing the extra work.' },
    ])
  })

  test('no text before the nudge: post-nudge text still reports something', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      endReminderUserMessage(),
      assistantMessage([
        { type: 'text', text: 'Here is the report you asked for.' },
        endTurnBlock(endTurnId),
      ]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([
      { type: 'text', text: 'Here is the report you asked for.' },
    ])
  })

  test('owned-tasks reminder is not the end-turn nudge: reply text wins', () => {
    const endTurnId = randomUUID()
    const result = finalize([
      assistantMessage([{ type: 'text', text: 'Initial findings.' }]),
      ownedTasksReminderUserMessage(),
      assistantMessage([
        { type: 'text', text: 'Still waiting on the background build task.' },
        endTurnBlock(endTurnId),
      ]),
      userToolResult(endTurnId),
    ])

    expect(result.content).toEqual([
      { type: 'text', text: 'Still waiting on the background build task.' },
    ])
  })

  test('partial result after a kill also skips the post-nudge restatement', () => {
    const partial = extractPartialResult([
      assistantMessage([{ type: 'text', text: 'Real partial report.' }]),
      endReminderUserMessage(),
      assistantMessage([{ type: 'text', text: 'Restated partial report.' }]),
    ])

    expect(partial).toBe('Real partial report.')
  })
})
