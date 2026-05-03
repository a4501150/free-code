import { afterEach, describe, expect, test } from 'bun:test'
import { createCodexFetch } from '../../src/services/api/codex-fetch-adapter.js'

const originalFetch = globalThis.fetch

function anthropicRequest(signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    signal,
  }
}

function adapterFetch() {
  return createCodexFetch({
    accessToken: 'unused',
    baseUrl: 'http://localhost',
    getSessionId: () => 'test-session',
  })
}

describe('Codex adapter: stream cancellation', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('forwards caller abort signal to upstream fetch before response headers', async () => {
    let upstreamSignal: AbortSignal | undefined
    let abortObserved = false

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener('abort', () => {
          abortObserved = true
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof globalThis.fetch

    const controller = new AbortController()
    const responsePromise = adapterFetch()(
      'http://localhost/v1/messages',
      anthropicRequest(controller.signal),
    )

    expect(upstreamSignal).toBeDefined()
    controller.abort('parent abort')

    try {
      await responsePromise
      throw new Error('Expected adapter fetch to reject')
    } catch (err) {
      expect((err as Error).name).toBe('AbortError')
    }

    expect(abortObserved).toBe(true)
    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toBe('parent abort')
  })

  test('keeps caller abort wired after response headers', async () => {
    let upstreamSignal: AbortSignal | undefined

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {},
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    const controller = new AbortController()
    const response = await adapterFetch()(
      'http://localhost/v1/messages',
      anthropicRequest(controller.signal),
    )

    expect(upstreamSignal).toBeDefined()
    expect(upstreamSignal?.aborted).toBe(false)

    controller.abort('late abort')

    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toBe('late abort')
    await response.body?.cancel('test cleanup')
  })

  test('cancelling transformed response aborts and cancels upstream stream', async () => {
    let upstreamSignal: AbortSignal | undefined
    let upstreamCancelReason: unknown

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  'event: response.output_text.delta',
                  'data: {"type":"response.output_text.delta","delta":"partial"}',
                  '',
                ].join('\n'),
              ),
            )
          },
          cancel(reason) {
            upstreamCancelReason = reason
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    const response = await adapterFetch()(
      'http://localhost/v1/messages',
      anthropicRequest(),
    )

    await response.body?.cancel('downstream cancel')

    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toBe('downstream cancel')
    expect(upstreamCancelReason).toBe('downstream cancel')
  })
})
