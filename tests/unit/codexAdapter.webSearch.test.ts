import { describe, expect, test } from 'bun:test'
import { codexAdapter } from '../../src/services/api/adapters/codex-adapter-impl.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'
import type { DomainStreamEvent } from '../../src/types/domain.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'

const baseConfig: ProviderConfig = {
  type: 'openai-responses',
  baseUrl: 'http://localhost:9999',
  models: [{ id: 'gpt-test' }],
  auth: { active: 'bearer', bearer: { token: 'test-token' } },
}

const searchTool = {
  type: 'web_search_20250305',
  name: 'web_search',
  description: 'Search the web',
  input_schema: { type: 'object', properties: { query: { type: 'string' } } },
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

async function runStream(
  config: ProviderConfig,
  request: DomainMessageRequest,
  body: string,
) {
  let requestBody: Record<string, unknown> = {}
  const fetchOverride = (async (_url: string, init: RequestInit) => {
    requestBody = JSON.parse(init.body as string)
    return new Response(
      body +
        sseLines('response.completed', {
          response: { usage: { input_tokens: 10, output_tokens: 5 } },
        }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch
  const response = await codexAdapter.createStream(
    config,
    request,
    new AbortController().signal,
    fetchOverride,
  )
  const events: DomainStreamEvent[] = []
  for await (const event of response.stream) events.push(event)
  return { events, requestBody }
}

describe('Codex Responses hosted web_search', () => {
  const config: ProviderConfig = {
    ...baseConfig,
    capabilities: { webSearch: true },
  }

  test('sends native web_search tool and never forces it as tool_choice', async () => {
    const { requestBody } = await runStream(
      config,
      makeRequest({
        tools: [searchTool as never],
        toolChoice: { type: 'tool', name: 'web_search' },
      }),
      '',
    )
    expect(requestBody.tools).toEqual([
      { type: 'web_search', external_web_access: true },
    ])
    expect(requestBody.tool_choice).toBe('auto')
  })

  test('capability comes from provider config, not model string lookup', async () => {
    const { requestBody } = await runStream(
      baseConfig,
      makeRequest({
        tools: [searchTool as never],
        toolChoice: { type: 'tool', name: 'web_search' },
      }),
      '',
    )
    expect(requestBody.tools).toEqual([])
  })

  test('defers result block and fills it from message url_citation annotations', async () => {
    const stream =
      sseLines('response.output_item.added', {
        item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
      }) +
      sseLines('response.web_search_call.completed', { item_id: 'ws_1' }) +
      sseLines('response.output_item.done', {
        item: {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: {
            type: 'search',
            query: 'latest news',
            queries: ['latest news'],
          },
        },
      }) +
      sseLines('response.output_item.added', {
        item: { type: 'message', id: 'msg_1' },
      }) +
      sseLines('response.output_text.delta', {
        item_id: 'msg_1',
        delta: 'Headline here',
      }) +
      sseLines('response.output_item.done', {
        item: {
          type: 'message',
          id: 'msg_1',
          content: [
            {
              type: 'output_text',
              text: 'Headline here',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://example.com/news',
                  title: 'Headline here',
                  start_index: 0,
                  end_index: 13,
                },
              ],
            },
          ],
        },
      })

    const { events } = await runStream(config, makeRequest(), stream)

    const blocks = events
      .filter(e => e.type === 'content_block_start')
      .map(e => (e as { content_block: { type: string } }).content_block.type)
    expect(blocks).toContain('server_tool_use')
    expect(blocks).toContain('web_search_tool_result')

    const result = events
      .filter(e => e.type === 'content_block_start')
      .map(e => e as { content_block: Record<string, unknown> })
      .find(e => e.content_block.type === 'web_search_tool_result')
    expect(result?.content_block.content).toEqual([
      {
        type: 'web_search_result',
        url: 'https://example.com/news',
        title: 'Headline here',
      },
    ])

    const usage = events
      .filter(e => e.type === 'message_delta')
      .map(e => (e as { usage: Record<string, unknown> }).usage)
    expect(usage[0].server_tool_use).toEqual({ web_search_requests: 1 })
  })
})
