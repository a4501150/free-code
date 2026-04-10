import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'

describe('Conversation Flow Integrity', () => {
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

  test('first request contains user message', async () => {
    server.reset([textResponse('Got it')])

    await runCLI({
      prompt: 'Hello from the test',
      serverUrl: server.url,
      maxTurns: 1,
    })

    const log = server.getRequestLog()
    expect(log.length).toBe(1)

    const messages = log[0].body.messages as Array<{
      role: string
      content: unknown
    }>
    expect(messages.length).toBeGreaterThanOrEqual(1)

    // First message should be from user
    expect(messages[0].role).toBe('user')

    // User message should contain the prompt text somewhere in its content
    const content = messages[0].content
    const contentStr =
      typeof content === 'string'
        ? content
        : JSON.stringify(content)
    expect(contentStr).toContain('Hello from the test')
  })

  test('first request contains tool definitions', async () => {
    server.reset([textResponse('OK')])

    await runCLI({
      prompt: 'Test tools',
      serverUrl: server.url,
      maxTurns: 1,
    })

    const log = server.getRequestLog()
    expect(log.length).toBe(1)

    // The request should have a tools array
    const tools = log[0].body.tools as Array<{ name: string }>
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)

    // Should include some common tools (bare mode may limit the set)
    const toolNames = tools.map((t) => t.name)
    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Read')
    expect(toolNames).toContain('Edit')
  })

  test('after tool use, next request has tool_result', async () => {
    const toolId = 'toolu_flow_001'
    server.reset([
      toolUseResponse([
        { name: 'Bash', id: toolId, input: { command: 'echo "flow_test"' } },
      ]),
      textResponse('Done'),
    ])

    await runCLI({
      prompt: 'Test flow',
      serverUrl: server.url,
      maxTurns: 3,
    })

    const log = server.getRequestLog()
    expect(log.length).toBe(2)

    // Second request should contain the tool_result
    const secondMessages = log[1].body.messages as Array<{
      role: string
      content: unknown
    }>

    // Find the tool_result in the messages
    let foundToolResult = false
    for (const msg of secondMessages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{
          type: string
          tool_use_id?: string
        }>) {
          if (block.type === 'tool_result' && block.tool_use_id === toolId) {
            foundToolResult = true
          }
        }
      }
    }
    expect(foundToolResult).toBe(true)
  })

  test('tool_result references correct tool_use_id', async () => {
    const toolId1 = 'toolu_ref_001'
    const toolId2 = 'toolu_ref_002'

    server.reset([
      // Two parallel tools with known IDs
      toolUseResponse([
        { name: 'Bash', id: toolId1, input: { command: 'echo "a"' } },
        { name: 'Bash', id: toolId2, input: { command: 'echo "b"' } },
      ]),
      textResponse('Both done'),
    ])

    await runCLI({
      prompt: 'Test refs',
      serverUrl: server.url,
      maxTurns: 3,
    })

    const log = server.getRequestLog()
    expect(log.length).toBe(2)

    // Extract all tool_result blocks from the second request
    const secondMessages = log[1].body.messages as Array<{
      role: string
      content: unknown
    }>

    const toolResultIds: string[] = []
    for (const msg of secondMessages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{
          type: string
          tool_use_id?: string
        }>) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id)
          }
        }
      }
    }

    // Both tool IDs should be referenced
    expect(toolResultIds).toContain(toolId1)
    expect(toolResultIds).toContain(toolId2)
  })

  test('full history preserved in Nth request', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "round1"' } },
      ]),
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "round2"' } },
      ]),
      textResponse('All rounds complete'),
    ])

    await runCLI({
      prompt: 'Multi-round history test',
      serverUrl: server.url,
      maxTurns: 5,
    })

    const log = server.getRequestLog()
    expect(log.length).toBe(3)

    // Each subsequent request should have more messages than the previous
    const msg1Count = (log[0].body.messages as unknown[]).length
    const msg2Count = (log[1].body.messages as unknown[]).length
    const msg3Count = (log[2].body.messages as unknown[]).length

    expect(msg2Count).toBeGreaterThan(msg1Count)
    expect(msg3Count).toBeGreaterThan(msg2Count)

    // Third request should have the original user message
    const thirdMessages = log[2].body.messages as Array<{
      role: string
      content: unknown
    }>
    expect(thirdMessages[0].role).toBe('user')
  })
})
