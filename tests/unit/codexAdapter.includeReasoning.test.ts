/**
 * Unit test: Codex adapter sets `include: ["reasoning.encrypted_content"]`
 * on the outbound Responses API request body. This is required for the
 * round-trip capability — without it, OpenAI's server will not return
 * encrypted_content and cross-turn reasoning continuity degrades.
 */

import { describe, expect, test } from 'bun:test'
import { createCodexFetch } from '../../src/services/api/codex-fetch-adapter.js'

describe('Codex adapter: include reasoning.encrypted_content', () => {
  test('translateToCodexBody emits include array with reasoning.encrypted_content', async () => {
    let capturedBody: Record<string, unknown> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      const sse = [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":0}}}',
        '',
        '',
      ].join('\n')
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    try {
      const adapterFetch = createCodexFetch({
        accessToken: 'unused',
        baseUrl: 'http://localhost',
        getSessionId: () => 'test-session',
      })

      const response = await adapterFetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      if (response.body) {
        const reader = response.body.getReader()
        while (!(await reader.read()).done) {
          /* noop */
        }
      }

      expect(Array.isArray(capturedBody.include)).toBe(true)
      expect(capturedBody.include).toContain('reasoning.encrypted_content')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
