import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import {
  calculateAgentProgressTokens,
  processProgressMessages,
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

  test('agent progress tokens do not drop when the subagent compacts', () => {
    // Auto-compaction collapses the cumulative input_tokens the API reports.
    // The counter tracks the peak so it never runs backwards.
    expect(
      calculateAgentProgressTokens([
        agentProgressMessage({ inputTokens: 150_000, outputTokens: 400 }),
        agentProgressMessage({
          progressId: 'progress-2',
          assistantId: 'assistant-2',
          messageId: 'msg-2',
          inputTokens: 20_000,
          outputTokens: 100,
          toolUseId: 'tool-2',
        }),
      ]),
    ).toBe(150_500)
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

  test('EndTurn completion call is stripped from the progress/expand display', () => {
    const endTurnMessage = {
      ...agentProgressMessage({ toolUseId: 'tool-endturn' }),
      data: {
        ...agentProgressMessage({ toolUseId: 'tool-endturn' }).data,
        message: {
          ...agentProgressMessage({ toolUseId: 'tool-endturn' }).data.message,
          message: {
            ...agentProgressMessage({ toolUseId: 'tool-endturn' }).data.message
              .message,
            content: [
              { type: 'text', text: 'Final report.' },
              {
                type: 'tool_use',
                id: 'tool-endturn',
                name: 'EndTurn',
                input: {},
              },
            ],
          },
        },
      },
    } as ProgressMessage<Progress>

    const processed = processProgressMessages(
      [agentProgressMessage(), endTurnMessage],
      [] as never,
      false,
    )

    // The response text survives; the EndTurn card does not.
    expect(processed).toHaveLength(2)
    const last = processed[1]!.message.data.message.message
    expect(
      (last.content as Array<{ type: string; text?: string }>).find(
        b => b.type === 'text',
      )?.text,
    ).toBe('Final report.')
    expect(
      (last.content as Array<{ type: string; name?: string }>).filter(
        b => b.type === 'tool_use' && b.name === 'EndTurn',
      ),
    ).toHaveLength(0)
    // Display copy only — the original message keeps its EndTurn block
    // (recorded transcripts and full transcript views still show it).
    expect(
      (
        endTurnMessage.data.message.message.content as Array<{ name?: string }>
      ).some(b => b.name === 'EndTurn'),
    ).toBe(true)
  })

  test('an EndTurn-only final message is dropped from the progress display', () => {
    const endTurnOnly = {
      ...agentProgressMessage({ toolUseId: 'tool-endturn' }),
      data: {
        ...agentProgressMessage({ toolUseId: 'tool-endturn' }).data,
        message: {
          ...agentProgressMessage({ toolUseId: 'tool-endturn' }).data.message,
          message: {
            ...agentProgressMessage({ toolUseId: 'tool-endturn' }).data.message
              .message,
            content: [
              {
                type: 'tool_use',
                id: 'tool-endturn',
                name: 'EndTurn',
                input: {},
              },
            ],
          },
        },
      },
    } as ProgressMessage<Progress>

    const processed = processProgressMessages(
      [agentProgressMessage(), endTurnOnly],
      [] as never,
      false,
    )

    // Only the real Bash call remains.
    expect(processed).toHaveLength(1)
    expect(
      (
        processed[0]!.message.data.message.message.content as Array<{
          name?: string
        }>
      )[0]!.name,
    ).toBe('Bash')
  })
})
