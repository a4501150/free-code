/**
 * Provider Config E2E Tests
 *
 * Tests the provider-based model system: configuring providers in settings.json,
 * routing requests through OpenAI Chat Completions adapter, model alias resolution,
 * per-provider caching behavior, and legacy env var migration.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { MockOpenAIServer } from '../helpers/mock-openai-server'
import { textResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Provider Config E2E', () => {
  let anthropicServer: MockAnthropicServer
  let openaiServer: MockOpenAIServer

  beforeAll(async () => {
    anthropicServer = new MockAnthropicServer()
    await anthropicServer.start()
    openaiServer = new MockOpenAIServer()
    await openaiServer.start()
  })

  afterAll(() => {
    anthropicServer.stop()
    openaiServer.stop()
  })

  // ─── OpenAI Chat Completions Provider ─────────────────────

  describe('OpenAI Chat Completions Provider', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('routes requests through Chat Completions adapter', async () => {
      // Configure an OpenAI Chat Completions provider with a model
      // that the CLI will select when started with --model
      openaiServer.reset([{ kind: 'text', text: 'Hello from OpenAI!' }])
      anthropicServer.reset([textResponse('fallback')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: {
                active: 'apiKey',
                apiKey: { key: 'test-openai-key' },
              },
              models: [
                { id: 'test-model', label: 'Test Model' },
              ],
            },
          },
        },
        additionalArgs: ['--model', 'test-model'],
      })
      await session.start()

      await session.sendLine('Say hello')
      const screen = await session.waitForText('Hello from OpenAI', 15_000)
      expect(screen).toContain('Hello from OpenAI')

      // Verify the request went to the OpenAI server
      const openaiRequests = openaiServer.getRequestLog()
      expect(openaiRequests.length).toBeGreaterThanOrEqual(1)
      expect(openaiRequests[0]!.body.model).toBe('test-model')

      // Verify it was a Chat Completions format request
      expect(openaiRequests[0]!.body.messages).toBeDefined()
      expect(openaiRequests[0]!.body.stream).toBe(true)
    })

    test('translates system prompt to system message', async () => {
      openaiServer.reset([{ kind: 'text', text: 'OK' }])
      anthropicServer.reset([textResponse('fallback')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: {
                active: 'apiKey',
                apiKey: { key: 'test-key' },
              },
              models: [{ id: 'test-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-model'],
      })
      await session.start()

      await session.sendLine('Hello')
      await session.waitForText('OK', 15_000)

      const requests = openaiServer.getRequestLog()
      expect(requests.length).toBeGreaterThanOrEqual(1)

      const messages = requests[0]!.body.messages as Array<{
        role: string
        content: unknown
      }>
      // Should have a system message (from system prompt) and a user message
      const systemMsg = messages.find((m) => m.role === 'system')
      expect(systemMsg).toBeDefined()

      const userMsg = messages.find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
    })

    test('sends auth headers correctly', async () => {
      openaiServer.reset([{ kind: 'text', text: 'Authed' }])
      anthropicServer.reset([textResponse('fallback')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: {
                active: 'apiKey',
                apiKey: { key: 'my-secret-key-123' },
              },
              models: [{ id: 'test-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-model'],
      })
      await session.start()

      await session.sendLine('Test auth')
      await session.waitForText('Authed', 15_000)

      const requests = openaiServer.getRequestLog()
      expect(requests.length).toBeGreaterThanOrEqual(1)
      expect(requests[0]!.headers['authorization']).toBe(
        'Bearer my-secret-key-123',
      )
    })

    test('tool use through Chat Completions adapter', async () => {
      // First response: tool call to read a file
      // Second response: text after tool result
      openaiServer.reset([
        {
          kind: 'tool_call',
          toolCalls: [
            {
              id: 'call_test_001',
              name: 'Bash',
              arguments: JSON.stringify({
                command: 'echo "tool test ok"',
                description: 'Test tool',
              }),
            },
          ],
        },
        { kind: 'text', text: 'Tool executed successfully!' },
      ])
      anthropicServer.reset([textResponse('fallback')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: {
                active: 'apiKey',
                apiKey: { key: 'test-key' },
              },
              models: [{ id: 'test-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-model'],
      })
      await session.start()

      await session.submitAndApprove('Run a test command')
      const screen = await session.waitForText(
        'Tool executed successfully',
        20_000,
      )
      expect(screen).toContain('Tool executed successfully')

      // Verify tool definitions were sent in Chat Completions format
      const requests = openaiServer.getRequestLog()
      const firstReq = requests[0]!
      expect(firstReq.body.tools).toBeDefined()
      const tools = firstReq.body.tools as Array<{
        type: string
        function: { name: string }
      }>
      expect(tools[0]!.type).toBe('function')
      expect(tools[0]!.function).toBeDefined()

      // Second request should contain tool result
      if (requests.length >= 2) {
        const secondReq = requests[1]!
        const msgs = secondReq.body.messages as Array<{
          role: string
          tool_call_id?: string
        }>
        const toolMsg = msgs.find((m) => m.role === 'tool')
        expect(toolMsg).toBeDefined()
        expect(toolMsg!.tool_call_id).toBe('call_test_001')
      }
    })
  })

  // ─── Legacy Env Var Migration ──────────────────────────────

  describe('Legacy Env Var Migration', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('default Anthropic provider works without explicit providers config', async () => {
      // No providers in settings — should auto-migrate from ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
      anthropicServer.reset([textResponse('Legacy migration works!')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        // No providers config — legacy migration kicks in
      })
      await session.start()

      await session.sendLine('Test legacy')
      const screen = await session.waitForText(
        'Legacy migration works',
        15_000,
      )
      expect(screen).toContain('Legacy migration works')

      // Verify the request went to the Anthropic mock server
      const requests = anthropicServer.getRequestLog()
      expect(requests.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ─── Per-Provider Caching ──────────────────────────────────

  describe('Per-Provider Caching', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('automatic-prefix provider has no cache_control in requests', async () => {
      openaiServer.reset([{ kind: 'text', text: 'No cache markers' }])
      anthropicServer.reset([textResponse('fallback')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              cache: { type: 'automatic-prefix' },
              auth: {
                active: 'apiKey',
                apiKey: { key: 'test-key' },
              },
              models: [{ id: 'test-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-model'],
      })
      await session.start()

      await session.sendLine('Test caching')
      await session.waitForText('No cache markers', 15_000)

      // The Chat Completions format doesn't have cache_control,
      // so the adapter naturally strips it. Verify the request body
      // doesn't contain any cache_control references.
      const requests = openaiServer.getRequestLog()
      expect(requests.length).toBeGreaterThanOrEqual(1)
      const bodyStr = JSON.stringify(requests[0]!.body)
      expect(bodyStr).not.toContain('cache_control')
    })
  })
})
