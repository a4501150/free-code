import { afterEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import { queryModelWithStreaming } from '../../src/services/api/claude.js'
import { enableConfigs } from '../../src/utils/config.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import { asSystemPrompt } from '../../src/utils/systemPromptType.js'
import { createUserMessage } from '../../src/utils/messages.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

function setupCodexProvider(): void {
  resetProviderRegistry()
  const providers: Record<string, ProviderConfig> = {
    codex: {
      type: 'openai-responses',
      baseUrl: 'http://codex.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'gpt-test' }],
    },
  }
  initProviderRegistry(providers)
}

describe('Codex stream retry', () => {
  afterEach(() => {
    resetProviderRegistry()
  })

  test('retries when stream ends before response.completed during SSE consumption', async () => {
    setupCodexProvider()
    enableConfigs()

    const originalFetch = globalThis.fetch
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const originalNodeEnv = process.env.NODE_ENV
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.NODE_ENV = 'development'
    let upstreamRequests = 0
    globalThis.fetch = (async () => {
      upstreamRequests++
      const firstTruncated = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"message"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"partial"}',
        '',
        '',
      ].join('\n')
      const secondComplete = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"message"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"complete"}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"message"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
        '',
      ].join('\n')
      return new Response(
        upstreamRequests === 1 ? firstTruncated : secondComplete,
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    let fallbackCount = 0
    const yielded = []
    try {
      for await (const message of queryModelWithStreaming({
        messages: [createUserMessage({ content: 'hi' })],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          model: 'gpt-test',
          isNonInteractiveSession: true,
          querySource: 'repl_main_thread',
          agents: [],
          allowedAgentTypes: [],
          hasAppendSystemPrompt: false,
          mcpTools: [],
          onStreamingFallback: () => {
            fallbackCount++
          },
        },
      })) {
        yielded.push(message)
      }
    } finally {
      globalThis.fetch = originalFetch
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }

    expect(upstreamRequests).toBe(2)
    expect(fallbackCount).toBe(1)
    expect(yielded.some(message => message.type === 'system')).toBe(true)
    const assistantTexts = yielded
      .filter(message => message.type === 'assistant')
      .flatMap(message =>
        Array.isArray(message.message.content)
          ? message.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
          : [],
      )
    expect(assistantTexts).toEqual(['partial', 'complete'])
  })

  test('retries mid-stream Codex server_error events', async () => {
    setupCodexProvider()
    enableConfigs()

    const originalFetch = globalThis.fetch
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const originalNodeEnv = process.env.NODE_ENV
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.NODE_ENV = 'development'
    let upstreamRequests = 0
    globalThis.fetch = (async () => {
      upstreamRequests++
      const firstServerError = [
        'event: response.failed',
        'data: {"type":"response.failed","response":{"error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."}}}',
        '',
        '',
      ].join('\n')
      const secondComplete = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"message"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"complete"}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"message"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
        '',
      ].join('\n')
      return new Response(
        upstreamRequests === 1 ? firstServerError : secondComplete,
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    let fallbackCount = 0
    const yielded = []
    try {
      for await (const message of queryModelWithStreaming({
        messages: [createUserMessage({ content: 'hi' })],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          model: 'gpt-test',
          isNonInteractiveSession: true,
          querySource: 'repl_main_thread',
          agents: [],
          allowedAgentTypes: [],
          hasAppendSystemPrompt: false,
          mcpTools: [],
          onStreamingFallback: () => {
            fallbackCount++
          },
        },
      })) {
        yielded.push(message)
      }
    } finally {
      globalThis.fetch = originalFetch
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }

    expect(upstreamRequests).toBe(2)
    expect(fallbackCount).toBe(1)
    expect(yielded.some(message => message.type === 'system')).toBe(true)
    const assistantTexts = yielded
      .filter(message => message.type === 'assistant')
      .flatMap(message =>
        Array.isArray(message.message.content)
          ? message.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
          : [],
      )
    expect(assistantTexts).toEqual(['complete'])
  })

  test('retries when Codex stream stalls after upstream events start', async () => {
    setupCodexProvider()
    enableConfigs()

    const originalFetch = globalThis.fetch
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const originalNodeEnv = process.env.NODE_ENV
    const originalWatchdog = process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
    const originalIdleTimeout = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '20'

    const encoder = new TextEncoder()
    let upstreamRequests = 0
    globalThis.fetch = (async () => {
      upstreamRequests++
      if (upstreamRequests === 1) {
        const firstStalled = [
          'event: response.output_item.added',
          'data: {"type":"response.output_item.added","item":{"type":"message"}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"partial"}',
          '',
          '',
        ].join('\n')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(firstStalled))
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        )
      }

      const secondComplete = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"message"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"complete"}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"message"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
        '',
      ].join('\n')
      return new Response(secondComplete, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    let fallbackCount = 0
    const yielded = []
    const abortController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          for await (const message of queryModelWithStreaming({
            messages: [createUserMessage({ content: 'hi' })],
            systemPrompt: asSystemPrompt([]),
            thinkingConfig: { type: 'disabled' },
            tools: [],
            signal: abortController.signal,
            options: {
              getToolPermissionContext: async () =>
                getEmptyToolPermissionContext(),
              model: 'gpt-test',
              isNonInteractiveSession: true,
              querySource: 'repl_main_thread',
              agents: [],
              allowedAgentTypes: [],
              hasAppendSystemPrompt: false,
              mcpTools: [],
              onStreamingFallback: () => {
                fallbackCount++
              },
            },
          })) {
            yielded.push(message)
          }
        })(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort()
            reject(new Error('stalled Codex stream test timed out'))
          }, 2_000)
        }),
      ])
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      globalThis.fetch = originalFetch
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
      if (originalWatchdog === undefined) {
        delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
      } else {
        process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = originalWatchdog
      }
      if (originalIdleTimeout === undefined) {
        delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
      } else {
        process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = originalIdleTimeout
      }
    }

    expect(upstreamRequests).toBe(2)
    expect(fallbackCount).toBe(1)
    expect(yielded.some(message => message.type === 'system')).toBe(true)
    const assistantTexts = yielded
      .filter(message => message.type === 'assistant')
      .flatMap(message =>
        Array.isArray(message.message.content)
          ? message.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
          : [],
      )
    expect(assistantTexts).toContain('complete')
  })
})
