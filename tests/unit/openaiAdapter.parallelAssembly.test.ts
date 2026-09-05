/**
 * Unit tests: streaming assembly of multiple tool_calls in one turn.
 *
 * SGLang streams both calls with distinct `index` values. The adapter must
 * give each call its own content block index; sharing one index makes the
 * second tool_use clobber the first and only one call survives.
 */
import { describe, test, expect } from 'bun:test'
import { openaiChatCompletionsAdapter } from '../../src/services/api/adapters/openai-chat-completions-adapter-impl.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'

const testConfig: ProviderConfig = {
  type: 'openai-chat-completions',
  baseUrl: 'http://localhost:9999/v1',
  models: [{ id: 'qwen' }],
  auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
}

const baseRequest: DomainMessageRequest = {
  model: 'qwen',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  maxTokens: 64,
  tools: [
    { name: 'get_weather', input_schema: { type: 'object', properties: {} } },
    { name: 'get_time', input_schema: { type: 'object', properties: {} } },
  ],
}

function sse(chunks: unknown[]): Response {
  const body =
    chunks
      .map(c => `data: ${JSON.stringify({ choices: [{ delta: {}, ...c }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function collectEvents(request: DomainMessageRequest, response: Response) {
  const events: any[] = []
  const res = await openaiChatCompletionsAdapter.createStream(
    testConfig,
    request,
    new AbortController().signal,
    (async () => response) as unknown as typeof globalThis.fetch,
  )
  for await (const ev of res.stream as AsyncGenerator<any>) {
    events.push(ev)
  }
  res.release()
  return events
}

describe('chat-completions stream: parallel tool call assembly', () => {
  test('two tool_calls get distinct block indices and routed deltas', async () => {
    const events = await collectEvents(baseRequest, sse([
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              function: { name: 'get_weather', arguments: '{"ci' },
            },
          ],
        },
      },
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }],
        },
      },
      {
        delta: {
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              function: { name: 'get_time', arguments: '{"zon' },
            },
          ],
        },
      },
      {
        delta: {
          tool_calls: [{ index: 1, function: { arguments: 'e":"Paris"}' } }],
        },
      },
      { delta: {}, finish_reason: 'tool_calls' },
    ]))

    const starts = events.filter(e => e.type === 'content_block_start')
    expect(starts.length).toBe(2)
    expect(starts[0].content_block.name).toBe('get_weather')
    expect(starts[1].content_block.name).toBe('get_time')
    expect(starts[0].index).not.toBe(starts[1].index)

    const jsonByBlock = new Map<number, string>()
    for (const e of events) {
      if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
        jsonByBlock.set(
          e.index,
          (jsonByBlock.get(e.index) ?? '') + e.delta.partial_json,
        )
      }
    }
    expect(JSON.parse(jsonByBlock.get(starts[0].index)!)).toEqual({
      city: 'Paris',
    })
    expect(JSON.parse(jsonByBlock.get(starts[1].index)!)).toEqual({
      zone: 'Paris',
    })
  })

  test('text followed by two tool calls keeps blocks separate', async () => {
    const events = await collectEvents(baseRequest, sse([
      { delta: { content: 'Calling both now.' } },
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
      },
      {
        delta: {
          tool_calls: [
            { index: 1, id: 'call_b', function: { name: 'get_time', arguments: '{}' } },
          ],
        },
      },
      { delta: {}, finish_reason: 'tool_calls' },
    ]))
    const starts = events.filter(e => e.type === 'content_block_start')
    const toolStarts = starts.filter(s => s.content_block.type === 'tool_use')
    expect(toolStarts.length).toBe(2)
    expect(new Set(toolStarts.map(s => s.index)).size).toBe(2)
    const textStart = starts.find(s => s.content_block.type === 'text')
    expect(textStart).toBeDefined()
    expect(
      new Set(starts.map(s => s.index)).size,
    ).toBe(starts.length)
  })
})
