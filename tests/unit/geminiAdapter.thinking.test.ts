/**
 * Unit tests: Gemini thinking config and thought-signature round-trip.
 *
 * Gemini 3 rejects multi-step function calling when a thought signature is
 * missing, so signatures must survive the response → history → request loop
 * verbatim and on the same part they arrived with.
 */
import { describe, test, expect, mock } from 'bun:test'

// The adapter obtains a GCP token before it will issue a request.
mock.module('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        getRequestHeaders: async () => ({ Authorization: 'Bearer test-token' }),
      }
    }
    async getProjectId() {
      return 'test-project'
    }
  },
}))

const { geminiAdapter } =
  await import('../../src/services/api/adapters/gemini-adapter-impl.js')
type ProviderConfig = import('../../src/utils/settings/types.js').ProviderConfig
type DomainMessageRequest =
  import('../../src/services/api/domain-transport.js').DomainMessageRequest
type DomainStreamEvent = import('../../src/types/domain.js').DomainStreamEvent

const testConfig = {
  type: 'gemini',
  baseUrl: 'http://localhost:9999/v1',
  models: [{ id: 'gemini-3-pro' }],
  auth: { gcp: { projectId: 'test-project', region: 'us-central1' } },
} as unknown as ProviderConfig

function makeRequest(
  overrides?: Partial<DomainMessageRequest>,
): DomainMessageRequest {
  return {
    model: 'gemini-3-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    maxTokens: 1024,
    ...overrides,
  } as DomainMessageRequest
}

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function capturedBody(
  request: DomainMessageRequest,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {}
  const fetchOverride = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string)
    return sseResponse([{ candidates: [{ finishReason: 'STOP' }] }])
  }) as unknown as typeof globalThis.fetch

  const streaming = await geminiAdapter.createStream(
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

async function collectEvents(chunks: unknown[]): Promise<DomainStreamEvent[]> {
  const fetchOverride = (async () =>
    sseResponse(chunks)) as unknown as typeof globalThis.fetch
  const streaming = await geminiAdapter.createStream(
    testConfig,
    makeRequest(),
    new AbortController().signal,
    fetchOverride,
  )
  const out: DomainStreamEvent[] = []
  for await (const event of streaming.stream) out.push(event)
  return out
}

function textPart(text: string, extra?: Record<string, unknown>) {
  return { candidates: [{ content: { parts: [{ text, ...extra }] } }] }
}

describe('gemini request: thinkingConfig', () => {
  test('adaptive thinking maps effort to a thinkingLevel', async () => {
    const body = await capturedBody(
      makeRequest({
        thinking: { type: 'adaptive' },
        outputConfig: { effort: 'low' },
      }),
    )
    expect(
      (body.generationConfig as Record<string, unknown>).thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' })
  })

  test('effort levels above HIGH clamp to HIGH', async () => {
    for (const effort of ['high', 'xhigh', 'max']) {
      const body = await capturedBody(
        makeRequest({
          thinking: { type: 'adaptive' },
          outputConfig: { effort },
        }),
      )
      const config = (body.generationConfig as Record<string, unknown>)
        .thinkingConfig as Record<string, unknown>
      expect(config.thinkingLevel).toBe('HIGH')
    }
  })

  test('an explicit budget maps to thinkingBudget', async () => {
    const body = await capturedBody(
      makeRequest({ thinking: { type: 'enabled', budgetTokens: 2048 } }),
    )
    expect(
      (body.generationConfig as Record<string, unknown>).thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingBudget: 2048 })
  })

  // Sending thinkingLevel and thinkingBudget together is an error.
  test('never sends both a level and a budget', async () => {
    const adaptive = await capturedBody(
      makeRequest({
        thinking: { type: 'adaptive' },
        outputConfig: { effort: 'medium' },
      }),
    )
    const budgeted = await capturedBody(
      makeRequest({ thinking: { type: 'enabled', budgetTokens: 1000 } }),
    )
    for (const body of [adaptive, budgeted]) {
      const config = (body.generationConfig as Record<string, unknown>)
        .thinkingConfig as Record<string, unknown>
      expect('thinkingLevel' in config && 'thinkingBudget' in config).toBe(
        false,
      )
    }
  })

  test('disabled thinking sends a zero budget', async () => {
    const body = await capturedBody(
      makeRequest({ thinking: { type: 'disabled' } }),
    )
    expect(
      (body.generationConfig as Record<string, unknown>).thinkingConfig,
    ).toEqual({ thinkingBudget: 0, includeThoughts: false })
  })

  test('no thinkingConfig when thinking was not requested', async () => {
    const body = await capturedBody(makeRequest())
    expect(
      (body.generationConfig as Record<string, unknown>)?.thinkingConfig,
    ).toBeUndefined()
  })
})

describe('gemini stream: thought parts', () => {
  test('a thought part becomes a reasoning block, not answer text', async () => {
    const events = await collectEvents([
      textPart('let me think', { thought: true }),
      textPart('the answer'),
      { candidates: [{ finishReason: 'STOP' }] },
    ])

    const starts = events.filter(e => e.type === 'content_block_start')
    expect(starts.map(e => (e.content_block as { type: string }).type)).toEqual(
      ['reasoning', 'text'],
    )

    const deltas = events.filter(e => e.type === 'content_block_delta')
    expect(deltas[0]?.delta).toMatchObject({
      type: 'thinking_delta',
      thinking: 'let me think',
    })
    expect(deltas[1]?.delta).toMatchObject({
      type: 'text_delta',
      text: 'the answer',
    })
  })

  test('consecutive thought parts stay in one reasoning block', async () => {
    const events = await collectEvents([
      textPart('first ', { thought: true }),
      textPart('second', { thought: true }),
      { candidates: [{ finishReason: 'STOP' }] },
    ])
    expect(events.filter(e => e.type === 'content_block_start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'content_block_delta')).toHaveLength(2)
  })

  test('a thought signature lands on the block it closed', async () => {
    const events = await collectEvents([
      textPart('reasoned', { thought: true, thoughtSignature: 'sig-1' }),
      { candidates: [{ finishReason: 'STOP' }] },
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      gemini: { thoughtSignature: 'sig-1' },
    })
  })

  // Gemini can attach a signature to a part with no text at all.
  test('a signature on an empty text part is still captured', async () => {
    const events = await collectEvents([
      textPart('', { thoughtSignature: 'sig-empty' }),
      { candidates: [{ finishReason: 'STOP' }] },
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      gemini: { thoughtSignature: 'sig-empty' },
    })
  })

  test('a signature on a function call lands on the tool_use block', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'Read', args: { path: 'a.ts' } },
                  thoughtSignature: 'sig-fc',
                },
              ],
            },
          },
        ],
      },
      { candidates: [{ finishReason: 'STOP' }] },
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      gemini: { thoughtSignature: 'sig-fc' },
    })
  })

  test('no providerState when no signature arrived', async () => {
    const events = await collectEvents([
      textPart('plain'),
      { candidates: [{ finishReason: 'STOP' }] },
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toBeUndefined()
  })
})

describe('gemini outbound: thought-signature replay', () => {
  async function partsFor(content: unknown[]) {
    const body = await capturedBody(
      makeRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: content as never },
        ],
      }),
    )
    const contents = body.contents as Array<{
      parts: Record<string, unknown>[]
    }>
    return contents[1]!.parts
  }

  test('a signature replays on the function-call part it came from', async () => {
    const parts = await partsFor([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: { path: 'a.ts' },
        providerState: { gemini: { thoughtSignature: 'sig-fc' } },
      },
    ])
    expect(parts[0]).toEqual({
      functionCall: { name: 'Read', args: { path: 'a.ts' } },
      thoughtSignature: 'sig-fc',
    })
  })

  test('a signature replays on a text part', async () => {
    const parts = await partsFor([
      {
        type: 'text',
        text: 'answer',
        providerState: { gemini: { thoughtSignature: 'sig-text' } },
      },
    ])
    expect(parts[0]).toEqual({ text: 'answer', thoughtSignature: 'sig-text' })
  })

  test('reasoning replays as a thought part carrying its signature', async () => {
    const parts = await partsFor([
      {
        type: 'reasoning',
        text: 'because',
        providerState: { gemini: { thoughtSignature: 'sig-th' } },
      },
    ])
    expect(parts[0]).toEqual({
      text: 'because',
      thought: true,
      thoughtSignature: 'sig-th',
    })
  })

  // In a parallel batch only the first function call carries a signature, and
  // moving it to another call is explicitly invalid.
  test('only the part that had a signature gets one back', async () => {
    const parts = await partsFor([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: {},
        providerState: { gemini: { thoughtSignature: 'sig-1' } },
      },
      { type: 'tool_use', id: 'toolu_2', name: 'Grep', input: {} },
    ])
    expect(parts[0]!.thoughtSignature).toBe('sig-1')
    expect(parts[1]!.thoughtSignature).toBeUndefined()
  })

  test('part order is preserved', async () => {
    const parts = await partsFor([
      {
        type: 'reasoning',
        text: 'plan',
        providerState: { gemini: { thoughtSignature: 's1' } },
      },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      { type: 'text', text: 'done' },
    ])
    expect(parts.map(p => Object.keys(p)[0])).toEqual([
      'text',
      'functionCall',
      'text',
    ])
    expect(parts[0]).toMatchObject({ thought: true })
  })

  test('another provider\u2019s state does not become a thought signature', async () => {
    const parts = await partsFor([
      {
        type: 'text',
        text: 'answer',
        providerState: { anthropic: { signature: 'sig-anthropic' } },
      },
    ])
    expect(parts[0]).toEqual({ text: 'answer' })
  })
})

describe('gemini non-streaming: thought parts', () => {
  async function contentFor(parts: unknown[]) {
    const fetchOverride = (async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    const result = await geminiAdapter.createMessage(
      testConfig,
      makeRequest(),
      new AbortController().signal,
      fetchOverride,
    )
    return result.message.content as unknown as Array<Record<string, unknown>>
  }

  test('thought parts become reasoning blocks with their signature', async () => {
    const content = await contentFor([
      { text: 'thinking', thought: true, thoughtSignature: 'sig-1' },
      { text: 'answer' },
    ])
    expect(content[0]).toEqual({
      type: 'reasoning',
      text: 'thinking',
      providerState: { gemini: { thoughtSignature: 'sig-1' } },
    })
    expect(content[1]).toEqual({ type: 'text', text: 'answer' })
  })

  test('a function call keeps its signature', async () => {
    const content = await contentFor([
      {
        functionCall: { name: 'Read', args: { path: 'a.ts' } },
        thoughtSignature: 'sig-fc',
      },
    ])
    expect(content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Read',
      providerState: { gemini: { thoughtSignature: 'sig-fc' } },
    })
  })

  test('an empty text part carrying only a signature is kept', async () => {
    const content = await contentFor([{ text: '', thoughtSignature: 'sig-e' }])
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({
      type: 'text',
      providerState: { gemini: { thoughtSignature: 'sig-e' } },
    })
  })
})
