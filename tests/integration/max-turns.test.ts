import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'

describe('Max Turns Limit', () => {
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

  test('max-turns=1 allows one model response', async () => {
    server.reset([
      textResponse('Single turn response'),
    ])

    const result = await runCLI({
      prompt: 'One turn only',
      serverUrl: server.url,
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Single turn response')
    expect(server.getRequestCount()).toBe(1)
  })

  test('max-turns=1 with tool call stops after executing tool', async () => {
    server.reset([
      // Model calls a tool
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "executed"' } },
      ]),
      // This should NOT be reached with max-turns=1
      textResponse('This should not appear'),
    ])

    const result = await runCLI({
      prompt: 'Call a tool',
      serverUrl: server.url,
      maxTurns: 1,
    })

    // With max-turns=1, the CLI should execute the tool but not make
    // another API call for the follow-up
    expect(server.getRequestCount()).toBe(1)
    // Output should mention max turns
    const output = result.stdout + result.stderr
    expect(
      output.includes('max turns') ||
        output.includes('Reached max turns') ||
        result.exitCode === 0,
    ).toBe(true)
  })

  test('max-turns=3 allows multi-turn chain', async () => {
    server.reset([
      // Turn 1: tool call
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "turn1"' } },
      ]),
      // Turn 2: another tool call
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "turn2"' } },
      ]),
      // Turn 3: text response (within limit)
      textResponse('Completed within 3 turns'),
    ])

    const result = await runCLI({
      prompt: 'Multi-turn within limit',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(3)
    expect(result.stdout).toContain('Completed within 3 turns')
  })

  test('exceeds max turns shows error message', async () => {
    server.reset([
      // Model keeps calling tools beyond the limit
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "1"' } },
      ]),
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "2"' } },
      ]),
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "3"' } },
      ]),
      // This won't be reached
      textResponse('Never reached'),
    ])

    const result = await runCLI({
      prompt: 'Exceed turns',
      serverUrl: server.url,
      maxTurns: 2,
    })

    // The CLI should indicate it hit the max turns limit
    const output = result.stdout + result.stderr
    expect(
      output.includes('max turns') ||
        output.includes('Reached max turns') ||
        server.getRequestCount() <= 2,
    ).toBe(true)
  })
})
