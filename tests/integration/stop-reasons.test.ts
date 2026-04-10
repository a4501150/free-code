import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI, getResultMessage } from './test-helpers'
import { textResponse, toolUseResponse, maxTokensResponse } from './fixture-builders'

describe('Stop Reasons', () => {
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

  test('end_turn stop reason completes normally', async () => {
    server.reset([textResponse('Normal completion')])

    const result = await runCLI({
      prompt: 'Complete normally',
      serverUrl: server.url,
      maxTurns: 1,
      outputFormat: 'stream-json',
    })

    expect(result.exitCode).toBe(0)

    // Check result message in stream-json output
    const resultMsg = getResultMessage(result.parsed)
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.subtype).toBe('success')
  })

  test('tool_use stop reason triggers tool execution', async () => {
    server.reset([
      // stop_reason: "tool_use" (implicit in toolUseResponse)
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "tool executed"' } },
      ]),
      textResponse('Tool was executed successfully'),
    ])

    const result = await runCLI({
      prompt: 'Use a tool',
      serverUrl: server.url,
      maxTurns: 3,
      outputFormat: 'stream-json',
    })

    expect(result.exitCode).toBe(0)
    // Should have made 2 API calls (initial + after tool result)
    expect(server.getRequestCount()).toBe(2)

    const resultMsg = getResultMessage(result.parsed)
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.subtype).toBe('success')
  })

  test('max_tokens stop reason', async () => {
    // When stop_reason is max_tokens, the CLI may try to continue the response
    // so we provide a follow-up that ends normally
    server.reset([
      maxTokensResponse('This response was truncated because'),
      textResponse(' it was too long. Here is the rest.'),
    ])

    const result = await runCLI({
      prompt: 'Generate a long response',
      serverUrl: server.url,
      maxTurns: 3,
      outputFormat: 'stream-json',
    })

    // The CLI should complete (either by truncating or continuing)
    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
  })
})
