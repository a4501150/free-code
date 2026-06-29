import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  buildTool,
  getEmptyToolPermissionContext,
  type ToolUseContext,
  type Tools,
} from '../../src/Tool.js'
import { query } from '../../src/query.js'
import {
  isStreamTruncationError,
  queryModelWithStreaming,
} from '../../src/services/api/claude.js'
import { DomainTransportError } from '../../src/services/api/domain-errors.js'
import { enableConfigs } from '../../src/utils/config.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import { asSystemPrompt } from '../../src/utils/systemPromptType.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utils/messages.js'
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

function setupAnthropicProvider(): void {
  resetProviderRegistry()
  const providers: Record<string, ProviderConfig> = {
    anthropic: {
      type: 'anthropic',
      baseUrl: 'http://anthropic.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'claude-test' }],
    },
  }
  initProviderRegistry(providers)
}

function assistantTexts(messages: unknown[]): string[] {
  return messages
    .filter((message: any) => message.type === 'assistant')
    .flatMap((message: any) =>
      Array.isArray(message.message.content)
        ? message.message.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
        : [],
    )
}

function createMinimalToolUseContext(tools: Tools = []): ToolUseContext {
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fastMode: false,
    advisorModel: undefined,
    mcp: { tools: [], clients: [] },
    sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-test',
      tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
        allowedAgentTypes: [],
      },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
  } as unknown as ToolUseContext
}

function toolResultContents(messages: unknown[], toolUseId: string): unknown[] {
  return messages
    .filter((message: any) => message.type === 'user')
    .flatMap((message: any) =>
      Array.isArray(message.message.content)
        ? message.message.content
            .filter(
              (block: any) =>
                block.type === 'tool_result' && block.tool_use_id === toolUseId,
            )
            .map((block: any) => block.content)
        : [],
    )
}

function createTestTool(calls: unknown[]) {
  return buildTool({
    name: 'TestTool',
    inputSchema: z.object({ value: z.string() }),
    async description() {
      return 'Test tool'
    },
    async prompt() {
      return 'Test tool'
    },
    async call(input) {
      calls.push(input)
      return { data: `result:${input.value}` }
    },
    renderToolUseMessage() {
      return null
    },
    renderToolResultMessage() {
      return null
    },
  })
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

  test('offers provider-confirmed Codex output for recovery before retrying identical prompts', async () => {
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
      const completedThenTruncated = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"message"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"confirmed"}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"message"}}',
        '',
        '',
      ].join('\n')
      return new Response(completedThenTruncated, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    let fallbackCount = 0
    let recoveryCount = 0
    const recovered: string[] = []
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
          onStreamingRecovery: messages => {
            recoveryCount++
            recovered.push(...assistantTexts(messages))
            return true
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

    expect(upstreamRequests).toBe(1)
    expect(fallbackCount).toBe(0)
    expect(recoveryCount).toBe(1)
    expect(recovered).toEqual(['confirmed'])
    expect(assistantTexts(yielded)).toEqual(['confirmed'])
  })

  test('query loop preserves confirmed Codex history and tombstones unconfirmed output', async () => {
    setupCodexProvider()
    enableConfigs()

    const confirmed = createAssistantMessage({ content: 'confirmed' })
    const partial = createAssistantMessage({ content: 'partial' })
    const final = createAssistantMessage({ content: 'done' })
    const requests: unknown[][] = []
    let callCount = 0

    const outputs = []
    const terminal = await (async () => {
      const iterator = query({
        messages: [createUserMessage({ content: 'hi' })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext: createMinimalToolUseContext(),
        querySource: 'repl_main_thread',
        deps: {
          callModel: async function* (request: any) {
            requests.push(request.messages)
            callCount++
            if (callCount === 1) {
              yield confirmed
              yield partial
              request.options.onStreamingRecovery?.(
                [confirmed],
                new DomainTransportError({
                  normalized: {
                    kind: 'transport',
                    message: 'Codex stream ended before response.completed',
                    providerType: 'openai-responses',
                    raw: null,
                  },
                }),
              )
              return
            }
            yield final
          },
          microcompact: async messages => ({ messages }),
          autocompact: async () => ({ compactionResult: null }),
          uuid: () => 'test-query-chain-id',
        },
      })

      let next = await iterator.next()
      while (!next.done) {
        outputs.push(next.value)
        next = await iterator.next()
      }
      return next.value
    })()

    expect(terminal.reason).toBe('completed')
    expect(callCount).toBe(2)
    expect(
      outputs.some(
        (message: any) =>
          message.type === 'tombstone' &&
          assistantTexts([message.message]).includes('partial'),
      ),
    ).toBe(true)
    expect(assistantTexts(outputs)).toEqual(['confirmed', 'partial', 'done'])
    expect(assistantTexts(requests[1] ?? [])).toContain('confirmed')
    expect(assistantTexts(requests[1] ?? [])).not.toContain('partial')
  })

  test('query loop preserves confirmed Codex tool call and pairs its result after recovery', async () => {
    setupCodexProvider()
    enableConfigs()

    const calls: unknown[] = []
    const tools = [createTestTool(calls)]
    const confirmedToolUseId = 'toolu_confirmed'
    const partialToolUseId = 'toolu_partial'
    const confirmed = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: confirmedToolUseId,
          name: 'TestTool',
          input: { value: 'confirmed' },
        },
      ],
    })
    const partial = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: partialToolUseId,
          name: 'TestTool',
          input: { value: 'partial' },
        },
      ],
    })
    const final = createAssistantMessage({ content: 'done' })
    const requests: unknown[][] = []
    let callCount = 0

    const outputs = []
    const terminal = await (async () => {
      const iterator = query({
        messages: [createUserMessage({ content: 'hi' })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async (_tool, input) => ({
          behavior: 'allow',
          updatedInput: input,
        }),
        toolUseContext: createMinimalToolUseContext(tools),
        querySource: 'repl_main_thread',
        deps: {
          callModel: async function* (request: any) {
            requests.push(request.messages)
            callCount++
            if (callCount === 1) {
              yield confirmed
              yield partial
              request.options.onStreamingRecovery?.(
                [confirmed],
                new DomainTransportError({
                  normalized: {
                    kind: 'transport',
                    message: 'Codex stream ended before response.completed',
                    providerType: 'openai-responses',
                    raw: null,
                  },
                }),
              )
              return
            }
            yield final
          },
          microcompact: async messages => ({ messages }),
          autocompact: async () => ({ compactionResult: null }),
          uuid: () => 'test-query-chain-id',
        },
      })

      let next = await iterator.next()
      while (!next.done) {
        outputs.push(next.value)
        next = await iterator.next()
      }
      return next.value
    })()

    const followUpRequest = requests[1] ?? []
    const requestToolUseIds = followUpRequest
      .filter((message: any) => message.type === 'assistant')
      .flatMap((message: any) =>
        Array.isArray(message.message.content)
          ? message.message.content
              .filter((block: any) => block.type === 'tool_use')
              .map((block: any) => block.id)
          : [],
      )

    expect(terminal.reason).toBe('completed')
    expect(callCount).toBe(2)
    expect(calls).toEqual([{ value: 'confirmed' }])
    expect(
      outputs.some(
        (message: any) =>
          message.type === 'tombstone' &&
          message.message.message.content.some(
            (block: any) =>
              block.type === 'tool_use' && block.id === partialToolUseId,
          ),
      ),
    ).toBe(true)
    expect(toolResultContents(outputs, confirmedToolUseId)).toEqual([
      'result:confirmed',
    ])
    expect(toolResultContents(outputs, partialToolUseId)).toEqual([])
    expect(requestToolUseIds).toContain(confirmedToolUseId)
    expect(requestToolUseIds).not.toContain(partialToolUseId)
    expect(toolResultContents(followUpRequest, confirmedToolUseId)).toEqual([
      'result:confirmed',
    ])
    expect(toolResultContents(followUpRequest, partialToolUseId)).toEqual([])
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

  test('isStreamTruncationError keys on the stream_truncated flag, not the message', () => {
    // Idle-timeout truncation: flagged, but the message has no "response.completed".
    const idleTruncation = new DomainTransportError({
      normalized: {
        kind: 'transport',
        message: 'Codex stream idle timeout waiting for upstream SSE',
        providerType: 'openai-responses',
        raw: { stream_truncated: true, mid_stream: true },
      },
    })
    // Clean-EOF truncation before completion: also flagged.
    const eofTruncation = new DomainTransportError({
      normalized: {
        kind: 'transport',
        message: 'Codex stream ended before response.completed',
        providerType: 'openai-responses',
        raw: { stream_truncated: true, mid_stream: true },
      },
    })
    // Generic mid-stream transport error from a different provider: not a truncation.
    const midStream = new DomainTransportError({
      normalized: {
        kind: 'transport',
        message: 'The operation was aborted.',
        providerType: 'anthropic',
        raw: { mid_stream: true },
      },
    })
    // The flag only counts for transport-kind errors.
    const serverError = new DomainTransportError({
      normalized: {
        kind: 'server',
        message: 'boom',
        providerType: 'openai-responses',
        raw: { stream_truncated: true },
      },
    })

    expect(isStreamTruncationError(idleTruncation)).toBe(true)
    expect(isStreamTruncationError(eofTruncation)).toBe(true)
    expect(isStreamTruncationError(midStream)).toBe(false)
    expect(isStreamTruncationError(serverError)).toBe(false)
    expect(isStreamTruncationError(new Error('nope'))).toBe(false)
  })

  test('query loop allows more than five consecutive stream recoveries', async () => {
    setupCodexProvider()
    enableConfigs()

    const final = createAssistantMessage({ content: 'done' })
    const recoveryResults: (boolean | undefined)[] = []
    let callCount = 0
    const truncationError = new DomainTransportError({
      normalized: {
        kind: 'transport',
        message: 'Codex stream ended before response.completed',
        providerType: 'openai-responses',
        raw: { stream_truncated: true, mid_stream: true },
      },
    })

    const outputs = []
    const terminal = await (async () => {
      const iterator = query({
        messages: [createUserMessage({ content: 'hi' })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext: createMinimalToolUseContext(),
        querySource: 'repl_main_thread',
        deps: {
          callModel: async function* (request: any) {
            callCount++
            // Confirm one new item per attempt, then truncate — seven times in a
            // row. The old cap of five would deny recovery on the sixth attempt.
            if (callCount <= 7) {
              const chunk = createAssistantMessage({
                content: `chunk${callCount}`,
              })
              yield chunk
              recoveryResults.push(
                request.options.onStreamingRecovery?.([chunk], truncationError),
              )
              return
            }
            yield final
          },
          microcompact: async messages => ({ messages }),
          autocompact: async () => ({ compactionResult: null }),
          uuid: () => 'test-query-chain-id',
        },
      })

      let next = await iterator.next()
      while (!next.done) {
        outputs.push(next.value)
        next = await iterator.next()
      }
      return next.value
    })()

    expect(callCount).toBe(8)
    expect(recoveryResults).toEqual([true, true, true, true, true, true, true])
    expect(terminal.reason).toBe('completed')
    expect(assistantTexts(outputs)).toContain('done')
  })

  test('recovers confirmed output when a Codex stream stalls (adapter watchdog only)', async () => {
    setupCodexProvider()
    enableConfigs()

    const originalFetch = globalThis.fetch
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const originalNodeEnv = process.env.NODE_ENV
    const originalWatchdog = process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
    const originalIdleTimeout = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.NODE_ENV = 'development'
    // Leave the generic watchdog at its default (opt-in/off). Only the Codex
    // adapter watchdog runs, so the stall surfaces deterministically as a
    // stream_truncated error that feeds recovery.
    delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '20'

    const encoder = new TextEncoder()
    let upstreamRequests = 0
    globalThis.fetch = (async () => {
      upstreamRequests++
      // Confirm one message item (output_item.done) then stall forever.
      const confirmedThenStalled = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"message"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"confirmed"}',
        '',
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"message"}}',
        '',
        '',
      ].join('\n')
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(confirmedThenStalled))
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    let fallbackCount = 0
    let recoveryCount = 0
    const recovered: string[] = []
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
              onStreamingRecovery: messages => {
                recoveryCount++
                recovered.push(...assistantTexts(messages))
                return true
              },
            },
          })) {
            yielded.push(message)
          }
        })(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort()
            reject(new Error('stalled Codex recovery test timed out'))
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

    // The stall is recovered, not retried from scratch: one upstream request,
    // no fallback, and the confirmed output is offered for recovery.
    expect(upstreamRequests).toBe(1)
    expect(fallbackCount).toBe(0)
    expect(recoveryCount).toBe(1)
    expect(recovered).toEqual(['confirmed'])
    expect(assistantTexts(yielded)).toEqual(['confirmed'])
  })
})

describe('Mid-stream retry (non-Codex)', () => {
  afterEach(() => {
    resetProviderRegistry()
  })

  test('retries mid-stream SSE error event with transport-like normalized error', async () => {
    setupAnthropicProvider()
    enableConfigs()

    const originalFetch = globalThis.fetch
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const originalNodeEnv = process.env.NODE_ENV
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.NODE_ENV = 'development'
    let upstreamRequests = 0

    const encoder = new TextEncoder()
    globalThis.fetch = (async () => {
      upstreamRequests++
      if (upstreamRequests === 1) {
        const partialThenError = [
          'event: message_start',
          `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}`,
          '',
          'event: content_block_start',
          `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
          '',
          'event: content_block_delta',
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })}`,
          '',
          'event: error',
          `data: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The operation was aborted.', normalized: { kind: 'transport', message: 'The operation was aborted.', providerType: 'anthropic', raw: { mid_stream: true } } } })}`,
          '',
          '',
        ].join('\n')
        return new Response(encoder.encode(partialThenError), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      const complete = [
        'event: message_start',
        `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}`,
        '',
        'event: content_block_start',
        `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        '',
        'event: content_block_delta',
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'complete' } })}`,
        '',
        'event: content_block_stop',
        `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        '',
        'event: message_delta',
        `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })}`,
        '',
        'event: message_stop',
        `data: ${JSON.stringify({ type: 'message_stop' })}`,
        '',
        '',
      ].join('\n')
      return new Response(encoder.encode(complete), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    let fallbackCount = 0
    const yielded: unknown[] = []
    try {
      for await (const message of queryModelWithStreaming({
        messages: [createUserMessage({ content: 'hi' })],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          model: 'claude-test',
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
    expect(
      yielded.some(
        (m: any) => m.type === 'system' && m.subtype === 'api_error',
      ),
    ).toBe(true)
    const assistantTexts = (yielded as any[])
      .filter((m: any) => m.type === 'assistant')
      .flatMap((m: any) =>
        Array.isArray(m.message.content)
          ? m.message.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
          : [],
      )
    expect(assistantTexts).toEqual(['complete'])
  })
})
