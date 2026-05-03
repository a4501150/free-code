import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import {
  calculateAgentProgressTokens,
  renderToolUseErrorMessage,
  renderToolUseRejectedMessage,
} from '../../src/tools/AgentTool/UI.js'
import type { ProgressMessage } from '../../src/types/message.js'
import type { Progress } from '../../src/tools/AgentTool/AgentTool.js'

function collectPropValues(node: React.ReactNode, propName: string): unknown[] {
  const values: unknown[] = []
  const visit = (value: React.ReactNode): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (!React.isValidElement(value)) return
    const props = value.props as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(props, propName)) {
      values.push(props[propName])
    }
    visit(props.children as React.ReactNode)
  }
  visit(node)
  return values
}

function agentProgressMessage({
  progressId = 'progress-1',
  assistantId = 'assistant-1',
  messageId = 'msg-1',
  inputTokens = 10,
  outputTokens = 5,
  toolUseId = 'tool-1',
}: {
  progressId?: string
  assistantId?: string
  messageId?: string
  inputTokens?: number
  outputTokens?: number
  toolUseId?: string
} = {}): ProgressMessage<Progress> {
  return {
    type: 'progress',
    uuid: progressId,
    timestamp: '2026-05-03T00:00:00.000Z',
    toolUseID: 'agent-tool-1',
    data: {
      type: 'agent_progress',
      prompt: 'Explore a bug',
      agentId: 'agent-1',
      message: {
        type: 'assistant',
        uuid: assistantId,
        timestamp: '2026-05-03T00:00:00.000Z',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'Bash',
              input: { command: 'echo hi' },
            },
          ],
        },
      },
    },
  } as ProgressMessage<Progress>
}

describe('AgentTool UI', () => {
  test('agent progress tokens stay visible across zero-usage updates', () => {
    expect(
      calculateAgentProgressTokens([
        agentProgressMessage({ inputTokens: 1000, outputTokens: 250 }),
        agentProgressMessage({
          progressId: 'progress-2',
          assistantId: 'assistant-2',
          messageId: 'msg-2',
          inputTokens: 0,
          outputTokens: 0,
          toolUseId: 'tool-2',
        }),
      ]),
    ).toBe(1250)
  })

  test('agent progress tokens deduplicate updates for the same assistant message', () => {
    expect(
      calculateAgentProgressTokens([
        agentProgressMessage({ inputTokens: 1000, outputTokens: 100 }),
        agentProgressMessage({
          progressId: 'progress-2',
          assistantId: 'assistant-1',
          messageId: 'msg-1',
          inputTokens: 1000,
          outputTokens: 180,
        }),
      ]),
    ).toBe(1180)
  })

  test('agent progress tokens include cumulative output from completed turns', () => {
    expect(
      calculateAgentProgressTokens([
        agentProgressMessage({ inputTokens: 1000, outputTokens: 100 }),
        agentProgressMessage({
          progressId: 'progress-2',
          assistantId: 'assistant-2',
          messageId: 'msg-2',
          inputTokens: 1500,
          outputTokens: 200,
          toolUseId: 'tool-2',
        }),
      ]),
    ).toBe(1800)
  })

  test('rejected agent progress is rendered as no longer running', () => {
    const node = renderToolUseRejectedMessage(
      {
        description: 'Explore',
        prompt: 'Explore a bug',
        subagent_type: 'Explore',
      },
      {
        columns: 80,
        messages: [],
        theme: 'dark',
        progressMessagesForMessage: [agentProgressMessage()],
        tools: {} as never,
        verbose: false,
      },
    )

    expect(collectPropValues(node, 'isAgentRunning')).toEqual([false])
  })

  test('errored agent progress is rendered as no longer running', () => {
    const node = renderToolUseErrorMessage('failed', {
      progressMessagesForMessage: [agentProgressMessage()],
      tools: {} as never,
      verbose: false,
    })

    expect(collectPropValues(node, 'isAgentRunning')).toEqual([false])
  })
})
