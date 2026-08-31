import { describe, expect, test } from 'bun:test'
import { codexAdapter } from '../../src/services/api/adapters/codex-adapter-impl.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'
import type { DomainStreamEvent } from '../../src/types/domain.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'

const testConfig: ProviderConfig = {
  type: 'openai-responses',
  baseUrl: 'http://localhost:9999',
  models: [{ id: 'gpt-test' }],
  auth: { active: 'bearer', bearer: { token: 'test-token' } },
}

function makeRequest(
  overrides: Partial<DomainMessageRequest> = {},
): DomainMessageRequest {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    maxTokens: 1024,
    ...overrides,
  }
}

function sseLines(eventType: string, data: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...data })}\n\n`
}

function completedSse(prefix: string): Response {
  const body =
    prefix +
    sseLines('response.completed', {
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function collectEvents(body: string): Promise<DomainStreamEvent[]> {
  const fetchOverride = (async () =>
    completedSse(body)) as unknown as typeof globalThis.fetch
  const response = await codexAdapter.createStream(
    testConfig,
    makeRequest(),
    new AbortController().signal,
    fetchOverride,
  )
  const events: DomainStreamEvent[] = []
  for await (const event of response.stream) events.push(event)
  return events
}

describe('Codex Responses reasoning request and replay', () => {
  test('sends opted-in summary mode and exact stored reasoning fields', async () => {
    let requestBody: Record<string, unknown> = {}
    const fetchOverride = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return completedSse(
        sseLines('response.output_item.added', {
          item: { type: 'message', id: 'msg_1' },
        }) +
          sseLines('response.output_text.delta', {
            item_id: 'msg_1',
            delta: 'ok',
          }) +
          sseLines('response.output_item.done', {
            item: {
              type: 'message',
              id: 'msg_1',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          }),
      )
    }) as unknown as typeof globalThis.fetch

    const response = await codexAdapter.createStream(
      testConfig,
      makeRequest({
        outputConfig: { effort: 'high', reasoningSummary: 'auto' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'First' }] },
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'streamed summary',
                providerState: {
                  openaiResponses: {
                    reasoningId: 'rs_1',
                    encryptedContent: 'encrypted',
                    summary: [
                      { type: 'summary_text', text: 'Stored summary.' },
                    ],
                    rawContent: [
                      { type: 'reasoning_text', text: 'Actual raw reasoning.' },
                    ],
                  },
                },
              },
              { type: 'text', text: 'Answer' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'Second' }] },
        ],
      }),
      new AbortController().signal,
      fetchOverride,
    )
    for await (const _ of response.stream) {
      // drain
    }

    expect(requestBody.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    const input = requestBody.input as Array<Record<string, unknown>>
    const reasoning = input.find(item => item.type === 'reasoning')
    expect(reasoning).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'encrypted',
      summary: [{ type: 'summary_text', text: 'Stored summary.' }],
      content: [{ type: 'reasoning_text', text: 'Actual raw reasoning.' }],
    })
  })

  test('does not add a summary field without model metadata', async () => {
    let requestBody: Record<string, unknown> = {}
    const fetchOverride = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return completedSse('')
    }) as unknown as typeof globalThis.fetch

    const response = await codexAdapter.createStream(
      testConfig,
      makeRequest({ outputConfig: { effort: 'high' } }),
      new AbortController().signal,
      fetchOverride,
    )
    for await (const _ of response.stream) {
      // drain
    }

    expect(requestBody.reasoning).toEqual({ effort: 'high' })
  })

  test('uses legacy text only as a summary fallback', async () => {
    let requestBody: Record<string, unknown> = {}
    const fetchOverride = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return completedSse('')
    }) as unknown as typeof globalThis.fetch

    const response = await codexAdapter.createStream(
      testConfig,
      makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'Legacy reasoning text.',
                providerState: {
                  openaiResponses: {
                    reasoningId: 'rs_legacy',
                    encryptedContent: 'encrypted',
                  },
                },
              },
            ],
          },
        ],
      }),
      new AbortController().signal,
      fetchOverride,
    )
    for await (const _ of response.stream) {
      // drain
    }

    const input = requestBody.input as Array<Record<string, unknown>>
    expect(input[0]).toEqual({
      type: 'reasoning',
      id: 'rs_legacy',
      encrypted_content: 'encrypted',
      summary: [{ type: 'summary_text', text: 'Legacy reasoning text.' }],
    })
  })
})

describe('Codex Responses reasoning parsing', () => {
  test('keeps summary, raw content, and multiple items separate', async () => {
    const itemOne = 'rs_one'
    const itemTwo = 'rs_two'
    const events = await collectEvents(
      sseLines('response.output_item.added', {
        item: { type: 'reasoning', id: itemOne, summary: [] },
      }) +
        sseLines('response.reasoning_text.delta', {
          item_id: itemOne,
          content_index: 0,
          delta: 'Actual raw reasoning.',
        }) +
        sseLines('response.reasoning_summary_part.added', {
          item_id: itemOne,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }) +
        sseLines('response.reasoning_summary_text.delta', {
          item_id: itemOne,
          summary_index: 0,
          delta: 'First summary.',
        }) +
        sseLines('response.reasoning_summary_text.done', {
          item_id: itemOne,
          summary_index: 1,
          text: 'Second summary.',
        }) +
        sseLines('response.output_item.done', {
          item: {
            type: 'reasoning',
            id: itemOne,
            encrypted_content: 'encrypted-one',
            summary: [
              { type: 'summary_text', text: 'First summary.' },
              { type: 'summary_text', text: 'Second summary.' },
            ],
            content: [
              { type: 'reasoning_text', text: 'Actual raw reasoning.' },
            ],
          },
        }) +
        sseLines('response.output_item.added', {
          item: { type: 'reasoning', id: itemTwo, summary: [] },
        }) +
        sseLines('response.output_item.done', {
          item: {
            type: 'reasoning',
            id: itemTwo,
            encrypted_content: 'encrypted-two',
            summary: [],
            content: [],
          },
        }),
    )

    const thinkingDeltas = events
      .filter(
        event =>
          event.type === 'content_block_delta' &&
          (event.delta as { type: string }).type === 'thinking_delta',
      )
      .map(event => (event.delta as { thinking: string }).thinking)
    expect(thinkingDeltas).toEqual(['First summary.', '\n\nSecond summary.'])
    expect(thinkingDeltas.join('')).not.toContain('Actual raw reasoning.')

    const stops = events.filter(
      event => event.type === 'content_block_stop' && event.providerState,
    )
    expect(stops).toHaveLength(2)
    expect(stops[0]!.providerState).toEqual({
      openaiResponses: {
        reasoningId: itemOne,
        encryptedContent: 'encrypted-one',
        summary: [
          { type: 'summary_text', text: 'First summary.' },
          { type: 'summary_text', text: 'Second summary.' },
        ],
        rawContent: [{ type: 'reasoning_text', text: 'Actual raw reasoning.' }],
      },
    })
    expect(stops[1]!.providerState).toEqual({
      openaiResponses: {
        reasoningId: itemTwo,
        encryptedContent: 'encrypted-two',
        summary: [],
        rawContent: [],
      },
    })
  })

  test('retains encrypted-only reasoning in non-streaming responses', async () => {
    const fetchOverride = (async () =>
      new Response(
        JSON.stringify({
          id: 'resp_1',
          output: [
            {
              type: 'reasoning',
              id: 'rs_opaque',
              encrypted_content: 'encrypted',
              summary: [],
              content: [],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    const response = await codexAdapter.createMessage(
      testConfig,
      makeRequest(),
      new AbortController().signal,
      fetchOverride,
    )

    expect(response.message.content).toEqual([
      {
        type: 'reasoning',
        text: '',
        providerState: {
          openaiResponses: {
            reasoningId: 'rs_opaque',
            encryptedContent: 'encrypted',
            summary: [],
            rawContent: [],
          },
        },
      },
    ])
  })
})
