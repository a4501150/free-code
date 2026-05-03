import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import {
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

function agentProgressMessage(): ProgressMessage<Progress> {
  return {
    type: 'progress',
    uuid: 'progress-1',
    timestamp: '2026-05-03T00:00:00.000Z',
    toolUseID: 'agent-tool-1',
    data: {
      type: 'agent_progress',
      prompt: 'Explore a bug',
      agentId: 'agent-1',
      message: {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-05-03T00:00:00.000Z',
        message: {
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
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
