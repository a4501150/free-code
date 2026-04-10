import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'

describe('Edge Cases', () => {
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

  test('special characters in prompt (quotes, backslashes)', async () => {
    server.reset([textResponse('Received special chars')])

    const result = await runCLI({
      prompt: 'Test with "double quotes" and \'single quotes\' and \\backslashes\\',
      serverUrl: server.url,
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)

    // Verify the prompt was sent correctly to the API
    const log = server.getRequestLog()
    expect(log.length).toBe(1)

    const messages = log[0].body.messages as Array<{
      role: string
      content: unknown
    }>
    const userContent = messages[0].content
    const contentStr =
      typeof userContent === 'string'
        ? userContent
        : JSON.stringify(userContent)
    expect(contentStr).toContain('double quotes')
    expect(contentStr).toContain('single quotes')
  })

  test('tool with large JSON input', async () => {
    // Create a large input object
    const largeInput: Record<string, unknown> = {
      command: 'echo "large input test"',
      description: 'x'.repeat(5000),
    }

    server.reset([
      toolUseResponse([{ name: 'Bash', input: largeInput }]),
      textResponse('Large input handled'),
    ])

    const result = await runCLI({
      prompt: 'Large input test',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(2)
  })

  test('tool with large output', async () => {
    server.reset([
      // Model runs a command that produces lots of output
      toolUseResponse([
        {
          name: 'Bash',
          input: { command: 'python3 -c "print(\'x\' * 50000)"' },
        },
      ]),
      textResponse('Handled the large output'),
    ])

    const result = await runCLI({
      prompt: 'Large output test',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(server.getRequestCount()).toBe(2)
  })

  test('multiple text blocks in one response', async () => {
    // A response with multiple text content blocks
    server.reset([
      {
        kind: 'success',
        response: {
          content: [
            { type: 'text' as const, text: 'First text block. ' },
            { type: 'text' as const, text: 'Second text block.' },
          ],
          stop_reason: 'end_turn' as const,
        },
      },
    ])

    const result = await runCLI({
      prompt: 'Multiple blocks',
      serverUrl: server.url,
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    // At least one of the text blocks should appear in output
    // (The CLI may only output the last text block in text mode, or concatenate them)
    const output = result.stdout
    expect(
      output.includes('First text block') ||
        output.includes('Second text block'),
    ).toBe(true)
  })
})
