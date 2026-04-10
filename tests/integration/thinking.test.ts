import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI, getAssistantMessages } from './test-helpers'
import {
  thinkingResponse,
  thinkingToolUseResponse,
  textResponse,
} from './fixture-builders'

describe('Extended Thinking', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  beforeEach(() => {
    server.reset([])
  })

  test('thinking block followed by text response', async () => {
    server.reset([
      thinkingResponse(
        'Let me think about this carefully. The user wants a greeting.',
        'Hello! I thought about it and here is my response.',
      ),
    ])

    const result = await runCLI({
      prompt: 'Think and respond',
      serverUrl: server.url,
      maxTurns: 1,
      // Enable thinking for this test
      additionalEnv: {
        CLAUDE_CODE_DISABLE_THINKING: '',
      },
    })

    expect(result.exitCode).toBe(0)
    // The text response should appear in output
    expect(result.stdout).toContain('Hello!')
    expect(server.getRequestCount()).toBe(1)
  })

  test('thinking block followed by tool use', async () => {
    server.reset([
      thinkingToolUseResponse(
        'I need to check the filesystem first.',
        [{ name: 'Bash', input: { command: 'ls -la' } }],
      ),
      textResponse('Listed the directory contents.'),
    ])

    const result = await runCLI({
      prompt: 'Think then use a tool',
      serverUrl: server.url,
      maxTurns: 3,
      additionalEnv: {
        CLAUDE_CODE_DISABLE_THINKING: '',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(2)
  })

  test('thinking with signature in stream-json output', async () => {
    const signature = 'EpUBCkYIAxgCIkD-test-signature-bytes'
    server.reset([
      thinkingResponse(
        'Deep analysis of the problem...',
        'Here is my conclusion.',
        signature,
      ),
    ])

    const result = await runCLI({
      prompt: 'Think deeply',
      serverUrl: server.url,
      maxTurns: 1,
      outputFormat: 'stream-json',
      additionalEnv: {
        CLAUDE_CODE_DISABLE_THINKING: '',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(1)

    // In stream-json, we should see assistant messages
    const messages = result.parsed as Array<Record<string, unknown>>
    const assistantMsgs = messages.filter((m) => m.type === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)
  })
})
