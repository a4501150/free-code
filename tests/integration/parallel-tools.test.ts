import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'

describe('Parallel Tool Calls', () => {
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

  test('two parallel tool_use blocks in one response', async () => {
    server.reset([
      // Turn 1: model calls two tools at once
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "parallel_a"' } },
        { name: 'Bash', input: { command: 'echo "parallel_b"' } },
      ]),
      // Turn 2: model summarizes both results
      textResponse('Both parallel commands completed: parallel_a and parallel_b'),
    ])

    const result = await runCLI({
      prompt: 'Run two commands in parallel',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(2)

    // Check that the second request has two tool_result blocks
    const log = server.getRequestLog()
    const secondRequest = log[1]
    const messages = secondRequest.body.messages as Array<{
      role: string
      content: unknown
    }>
    const lastMsg = messages[messages.length - 1]
    expect(lastMsg.role).toBe('user')
    const content = lastMsg.content as Array<{ type: string }>
    const toolResults = content.filter((c) => c.type === 'tool_result')
    expect(toolResults.length).toBe(2)
  })

  test('three parallel tool calls', async () => {
    server.reset([
      // Turn 1: three tools at once
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "one"' } },
        { name: 'Bash', input: { command: 'echo "two"' } },
        { name: 'Bash', input: { command: 'echo "three"' } },
      ]),
      // Turn 2: summarize
      textResponse('All three completed'),
    ])

    const result = await runCLI({
      prompt: 'Run three commands',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(2)

    // Verify three tool_result blocks in second request
    const log = server.getRequestLog()
    const secondRequest = log[1]
    const messages = secondRequest.body.messages as Array<{
      role: string
      content: unknown
    }>
    const lastMsg = messages[messages.length - 1]
    const content = lastMsg.content as Array<{ type: string }>
    const toolResults = content.filter((c) => c.type === 'tool_result')
    expect(toolResults.length).toBe(3)
  })

  test('mixed parallel: one succeeds, one fails', async () => {
    server.reset([
      // Turn 1: two parallel tools - one will succeed, one will fail
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "success"' } },
        { name: 'Bash', input: { command: 'false' } }, // exit code 1
      ]),
      // Turn 2: model acknowledges mixed results
      textResponse('One command succeeded and one failed'),
    ])

    const result = await runCLI({
      prompt: 'Run mixed commands',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(2)

    // Both tool results should be in the second request
    const log = server.getRequestLog()
    const secondRequest = log[1]
    const messages = secondRequest.body.messages as Array<{
      role: string
      content: unknown
    }>
    const lastMsg = messages[messages.length - 1]
    const content = lastMsg.content as Array<{
      type: string
      is_error?: boolean
    }>
    const toolResults = content.filter((c) => c.type === 'tool_result')
    expect(toolResults.length).toBe(2)
  })

  test('parallel tools followed by sequential tool', async () => {
    server.reset([
      // Turn 1: two parallel tools
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "p1"' } },
        { name: 'Bash', input: { command: 'echo "p2"' } },
      ]),
      // Turn 2: one sequential tool
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "seq"' } },
      ]),
      // Turn 3: final response
      textResponse('All done: p1, p2, seq'),
    ])

    const result = await runCLI({
      prompt: 'Run parallel then sequential',
      serverUrl: server.url,
      maxTurns: 5,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(3)
  })
})
