/**
 * Unit tests: Bedrock Converse extended thinking.
 *
 * Covers the request-side wiring (thinking / effort / betas into
 * additionalModelRequestFields) and the reasoning round-trip: signature and
 * redactedContent capture from ConverseStream and the non-streaming response,
 * and verbatim replay of both into outbound `messages`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { bedrockAdapter } from '../../src/services/api/adapters/bedrock-adapter-impl.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'
import type { DomainStreamEvent } from '../../src/types/domain.js'

const testConfig: ProviderConfig = {
  type: 'bedrock-converse',
  baseUrl: 'http://localhost:9999',
  models: [{ id: 'us.anthropic.claude-sonnet-4-6' }],
  auth: { aws: { region: 'us-east-1' } },
} as ProviderConfig

let previousSkipAuth: string | undefined
beforeAll(() => {
  previousSkipAuth = process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
})
afterAll(() => {
  if (previousSkipAuth === undefined) {
    delete process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
  } else {
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = previousSkipAuth
  }
})

function makeRequest(
  overrides?: Partial<DomainMessageRequest>,
): DomainMessageRequest {
  return {
    model: 'us.anthropic.claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    maxTokens: 1024,
    ...overrides,
  }
}

/** AWS EventStream frame: 12-byte prelude, headers, payload, 4-byte CRC. */
function eventStreamFrame(eventType: string, payload: unknown): Uint8Array {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))

  const header = (name: string, value: string): number[] => {
    const nameBytes = [...new TextEncoder().encode(name)]
    const valueBytes = [...new TextEncoder().encode(value)]
    return [
      nameBytes.length,
      ...nameBytes,
      7, // string header type
      (valueBytes.length >> 8) & 0xff,
      valueBytes.length & 0xff,
      ...valueBytes,
    ]
  }

  const headerBytes = [
    ...header(':message-type', 'event'),
    ...header(':event-type', eventType),
  ]
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4

  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, totalLength)
  view.setUint32(4, headerBytes.length)
  view.setUint32(8, 0) // prelude CRC, unchecked by the parser
  frame.set(headerBytes, 12)
  frame.set(payloadBytes, 12 + headerBytes.length)
  return frame
}

function eventStreamResponse(
  events: Array<[string, unknown]>,
): () => Promise<Response> {
  return async () => {
    const frames = events.map(([type, payload]) =>
      eventStreamFrame(type, payload),
    )
    const total = frames.reduce((n, f) => n + f.length, 0)
    const body = new Uint8Array(total)
    let offset = 0
    for (const frame of frames) {
      body.set(frame, offset)
      offset += frame.length
    }
    return new Response(body, {
      status: 200,
      headers: { 'x-amzn-requestid': 'req-1' },
    })
  }
}

/** Runs a request through the adapter and returns the parsed request body. */
async function capturedBody(
  request: DomainMessageRequest,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {}
  const fetchOverride = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string)
    return eventStreamResponse([['messageStop', { stopReason: 'end_turn' }]])()
  }) as unknown as typeof globalThis.fetch

  const streaming = await bedrockAdapter.createStream(
    testConfig,
    request,
    new AbortController().signal,
    fetchOverride,
  )
  for await (const _ of streaming.stream) {
    // drain
  }
  return captured
}

async function collectEvents(
  events: Array<[string, unknown]>,
): Promise<DomainStreamEvent[]> {
  const fetchOverride = eventStreamResponse(
    events,
  ) as unknown as typeof globalThis.fetch
  const streaming = await bedrockAdapter.createStream(
    testConfig,
    makeRequest(),
    new AbortController().signal,
    fetchOverride,
  )
  const out: DomainStreamEvent[] = []
  for await (const event of streaming.stream) out.push(event)
  return out
}

describe('bedrock request: additionalModelRequestFields', () => {
  test('manual thinking uses snake_case budget_tokens', async () => {
    const body = await capturedBody(
      makeRequest({ thinking: { type: 'enabled', budgetTokens: 4000 } }),
    )
    expect(body.additionalModelRequestFields).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 4000 },
    })
  })

  test('adaptive thinking sends no budget', async () => {
    const body = await capturedBody(
      makeRequest({
        thinking: { type: 'adaptive' },
        outputConfig: { effort: 'medium' },
      }),
    )
    const fields = body.additionalModelRequestFields as Record<string, unknown>
    expect(fields.thinking).toEqual({ type: 'adaptive' })
    expect(fields.output_config).toEqual({ effort: 'medium' })
  })

  test('betas ride through extraBody as anthropic_beta', async () => {
    const body = await capturedBody(
      makeRequest({
        extraBody: { anthropic_beta: ['interleaved-thinking-2025-05-14'] },
        thinking: { type: 'enabled', budgetTokens: 2000 },
      }),
    )
    expect(body.additionalModelRequestFields).toMatchObject({
      anthropic_beta: ['interleaved-thinking-2025-05-14'],
      thinking: { type: 'enabled', budget_tokens: 2000 },
    })
  })

  test('omitted entirely when there is nothing to send', async () => {
    const body = await capturedBody(makeRequest())
    expect(body.additionalModelRequestFields).toBeUndefined()
  })

  test('maxTokens stays camelCase in inferenceConfig', async () => {
    const body = await capturedBody(
      makeRequest({ thinking: { type: 'enabled', budgetTokens: 1024 } }),
    )
    expect(body.inferenceConfig).toMatchObject({ maxTokens: 1024 })
  })
})

describe('bedrock stream: reasoning capture', () => {
  test('reasoning text, then signature on content_block_stop', async () => {
    const events = await collectEvents([
      ['contentBlockStart', { contentBlockIndex: 0, start: {} }],
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'thinking hard' } },
        },
      ],
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: 'sig-abc' } },
        },
      ],
      ['contentBlockStop', { contentBlockIndex: 0 }],
      ['messageStop', { stopReason: 'end_turn' }],
    ])

    const start = events.find(e => e.type === 'content_block_start')
    expect(start?.content_block).toMatchObject({ type: 'reasoning' })

    const delta = events.find(e => e.type === 'content_block_delta')
    expect(delta?.delta).toMatchObject({
      type: 'thinking_delta',
      thinking: 'thinking hard',
    })

    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      bedrockConverse: { signature: 'sig-abc' },
    })
  })

  // AWS documents the signature as a delta member but never promises it
  // arrives in exactly one event.
  test('signature fragments accumulate across deltas', async () => {
    const events = await collectEvents([
      [
        'contentBlockDelta',
        { contentBlockIndex: 0, delta: { reasoningContent: { text: 'hm' } } },
      ],
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: 'sig-' } },
        },
      ],
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: 'tail' } },
        },
      ],
      ['contentBlockStop', { contentBlockIndex: 0 }],
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      bedrockConverse: { signature: 'sig-tail' },
    })
  })

  // ContentBlockStart only ever carries a toolUse member, so a reasoning block
  // must be recognised from its first delta or it opens as a text block and
  // the thinking_delta lands on the wrong type.
  test('a reasoning block with no start event still opens as reasoning', async () => {
    const events = await collectEvents([
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'no start' } },
        },
      ],
      ['contentBlockStop', { contentBlockIndex: 0 }],
    ])
    const start = events.find(e => e.type === 'content_block_start')
    expect(start?.content_block).toMatchObject({ type: 'reasoning' })
  })

  test('a text block with no start event still opens as text', async () => {
    const events = await collectEvents([
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'hi' } }],
      ['contentBlockStop', { contentBlockIndex: 0 }],
    ])
    const start = events.find(e => e.type === 'content_block_start')
    expect(start?.content_block).toMatchObject({ type: 'text' })
  })

  test('redactedContent opens a redacted_reasoning block', async () => {
    const events = await collectEvents([
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { redactedContent: 'YWJj' } },
        },
      ],
      ['contentBlockStop', { contentBlockIndex: 0 }],
    ])
    const start = events.find(e => e.type === 'content_block_start')
    expect(start?.content_block).toMatchObject({ type: 'redacted_reasoning' })
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      bedrockConverse: { redactedContent: 'YWJj' },
    })
  })

  // Concatenating padded base64 strings corrupts the bytes; they have to be
  // decoded and rejoined.
  test('redacted fragments are rejoined as bytes, not strings', async () => {
    const first = Buffer.from([1, 2, 3]).toString('base64')
    const second = Buffer.from([4, 5]).toString('base64')
    const events = await collectEvents([
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { redactedContent: first } },
        },
      ],
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { reasoningContent: { redactedContent: second } },
        },
      ],
      ['contentBlockStop', { contentBlockIndex: 0 }],
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    const joined = (
      stop?.providerState as { bedrockConverse: { redactedContent: string } }
    ).bedrockConverse.redactedContent
    expect([...Buffer.from(joined, 'base64')]).toEqual([1, 2, 3, 4, 5])
  })

  test('a block that produced no deltas emits no stop', async () => {
    const events = await collectEvents([
      ['contentBlockStart', { contentBlockIndex: 0, start: {} }],
      ['contentBlockStop', { contentBlockIndex: 0 }],
    ])
    expect(events.some(e => e.type === 'content_block_stop')).toBe(false)
  })

  test('no providerState when the block carried no signature', async () => {
    const events = await collectEvents([
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'plain' } }],
      ['contentBlockStop', { contentBlockIndex: 0 }],
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toBeUndefined()
  })
})

describe('bedrock outbound: reasoning replay', () => {
  async function messagesFor(
    content: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    const body = await capturedBody(
      makeRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: content as never },
        ],
      }),
    )
    const messages = body.messages as Array<Record<string, unknown>>
    return messages[1]!.content as Array<Record<string, unknown>>
  }

  test('signed reasoning replays as reasoningContent.reasoningText', async () => {
    const content = await messagesFor([
      {
        type: 'reasoning',
        text: 'because',
        providerState: { bedrockConverse: { signature: 'sig-1' } },
      },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { a: 1 } },
    ])
    expect(content[0]).toEqual({
      reasoningContent: {
        reasoningText: { text: 'because', signature: 'sig-1' },
      },
    })
    expect(content[1]).toMatchObject({ toolUse: { toolUseId: 'toolu_1' } })
  })

  test('redacted reasoning replays as reasoningContent.redactedContent', async () => {
    const content = await messagesFor([
      {
        type: 'redacted_reasoning',
        providerState: { bedrockConverse: { redactedContent: 'YWJj' } },
      },
    ])
    expect(content[0]).toEqual({
      reasoningContent: { redactedContent: 'YWJj' },
    })
  })

  test('unsigned reasoning is dropped rather than sent unverifiable', async () => {
    const content = await messagesFor([
      { type: 'reasoning', text: 'unsigned' },
      { type: 'text', text: 'answer' },
    ])
    expect(content).toEqual([{ text: 'answer' }])
  })

  test('foreign provider state is not mistaken for a bedrock signature', async () => {
    const content = await messagesFor([
      {
        type: 'reasoning',
        text: 'anthropic-signed',
        providerState: { anthropic: { signature: 'sig-anthropic' } },
      },
      { type: 'text', text: 'answer' },
    ])
    expect(content).toEqual([{ text: 'answer' }])
  })

  // Converse rejects an assistant turn whose signed blocks moved, so the
  // reasoning block must stay ahead of the toolUse it belongs to.
  test('block order is preserved', async () => {
    const content = await messagesFor([
      {
        type: 'reasoning',
        text: 'first',
        providerState: { bedrockConverse: { signature: 's1' } },
      },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      {
        type: 'reasoning',
        text: 'second',
        providerState: { bedrockConverse: { signature: 's2' } },
      },
      { type: 'text', text: 'done' },
    ])
    expect(content.map(b => Object.keys(b)[0])).toEqual([
      'reasoningContent',
      'toolUse',
      'reasoningContent',
      'text',
    ])
  })

  test('reasoning text is replayed verbatim, including trailing whitespace', async () => {
    const content = await messagesFor([
      {
        type: 'reasoning',
        text: '  padded  \n',
        providerState: { bedrockConverse: { signature: 's1' } },
      },
    ])
    expect(content[0]).toEqual({
      reasoningContent: {
        reasoningText: { text: '  padded  \n', signature: 's1' },
      },
    })
  })
})

describe('bedrock non-streaming: reasoning capture', () => {
  async function contentFor(
    blocks: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    const fetchOverride = (async () =>
      new Response(
        JSON.stringify({
          output: { message: { role: 'assistant', content: blocks } },
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    const result = await bedrockAdapter.createMessage(
      testConfig,
      makeRequest(),
      new AbortController().signal,
      fetchOverride,
    )
    return result.message.content as unknown as Array<Record<string, unknown>>
  }

  test('captures reasoningText signature', async () => {
    const content = await contentFor([
      {
        reasoningContent: {
          reasoningText: { text: 'because', signature: 'sig-1' },
        },
      },
      { text: 'answer' },
    ])
    expect(content[0]).toEqual({
      type: 'reasoning',
      text: 'because',
      providerState: { bedrockConverse: { signature: 'sig-1' } },
    })
    expect(content[1]).toEqual({ type: 'text', text: 'answer' })
  })

  test('captures redactedContent as a redacted_reasoning block', async () => {
    const content = await contentFor([
      { reasoningContent: { redactedContent: 'YWJj' } },
    ])
    expect(content[0]).toEqual({
      type: 'redacted_reasoning',
      providerState: { bedrockConverse: { redactedContent: 'YWJj' } },
    })
  })

  test('a byte-array redactedContent is base64-encoded once', async () => {
    const content = await contentFor([
      { reasoningContent: { redactedContent: [1, 2, 3] } },
    ])
    const state = (
      content[0] as {
        providerState: { bedrockConverse: { redactedContent: string } }
      }
    ).providerState
    expect([
      ...Buffer.from(state.bedrockConverse.redactedContent, 'base64'),
    ]).toEqual([1, 2, 3])
  })

  test('reasoning without a signature yields no providerState', async () => {
    const content = await contentFor([
      { reasoningContent: { reasoningText: { text: 'unsigned' } } },
    ])
    expect(content[0]).toEqual({ type: 'reasoning', text: 'unsigned' })
  })
})
