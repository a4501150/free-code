import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'

describe('Multi-Turn Tool Use', () => {
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

  test('two sequential tool calls', async () => {
    server.reset([
      // Turn 1: model runs first command
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "step1"' } },
      ]),
      // Turn 2: model runs second command
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "step2"' } },
      ]),
      // Turn 3: model summarizes
      textResponse('Completed both steps: step1 and step2'),
    ])

    const result = await runCLI({
      prompt: 'Run two commands',
      serverUrl: server.url,
      maxTurns: 5,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(3)
    expect(result.stdout).toContain('step1')
  })

  test('three-turn chain', async () => {
    server.reset([
      // Turn 1: first tool
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "a"' } },
      ]),
      // Turn 2: second tool
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "b"' } },
      ]),
      // Turn 3: third tool
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "c"' } },
      ]),
      // Turn 4: final text response
      textResponse('All three commands completed: a, b, c'),
    ])

    const result = await runCLI({
      prompt: 'Run three commands',
      serverUrl: server.url,
      maxTurns: 6,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(4)
  })

  test('tool results are sent back correctly in request body', async () => {
    const toolId = 'toolu_verify_001'
    server.reset([
      // Turn 1: model calls Bash with a known ID
      toolUseResponse([
        {
          name: 'Bash',
          id: toolId,
          input: { command: 'echo "test_output_xyz"' },
        },
      ]),
      // Turn 2: respond
      textResponse('Got the output'),
    ])

    const result = await runCLI({
      prompt: 'Run echo command',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)

    // Inspect the second API request
    const log = server.getRequestLog()
    expect(log.length).toBe(2)

    const secondRequest = log[1]
    const messages = secondRequest.body.messages as Array<{
      role: string
      content: unknown
    }>

    // Find the tool_result message
    const toolResultMsg = messages.find((m) => {
      if (m.role !== 'user') return false
      const content = m.content as Array<{ type: string; tool_use_id?: string }>
      return content?.some(
        (c) => c.type === 'tool_result' && c.tool_use_id === toolId,
      )
    })

    expect(toolResultMsg).toBeDefined()
  })

  test('message ordering is preserved across turns', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "first"' } },
      ]),
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "second"' } },
      ]),
      textResponse('Done'),
    ])

    const result = await runCLI({
      prompt: 'Do two things',
      serverUrl: server.url,
      maxTurns: 5,
    })

    expect(result.exitCode).toBe(0)

    // Check the third request has full history
    const log = server.getRequestLog()
    expect(log.length).toBe(3)

    const thirdRequest = log[2]
    const messages = thirdRequest.body.messages as Array<{
      role: string
      content: unknown
    }>

    // Messages should alternate: user, assistant, user(tool_result), assistant, user(tool_result)
    // First message should be user (the prompt)
    expect(messages[0].role).toBe('user')

    // Should have at least 5 messages by turn 3
    expect(messages.length).toBeGreaterThanOrEqual(5)

    // Verify alternation: no two consecutive messages have the same role
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })
})
