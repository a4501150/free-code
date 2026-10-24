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
import { END_TURN_TOOL_NAME } from '../../src/tools/EndTurnTool/constants.js'
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
