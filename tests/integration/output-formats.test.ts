import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI, getResultMessage, filterMessages } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'

describe('Output Formats', () => {
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

  test('text format returns plain text', async () => {
    server.reset([textResponse('Plain text output here')])

    const result = await runCLI({
      prompt: 'Say something',
      serverUrl: server.url,
      maxTurns: 1,
      outputFormat: 'text',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Plain text output here')
    // Should NOT be JSON
    expect(result.stdout.trimStart().startsWith('{')).toBe(false)
    expect(result.stdout.trimStart().startsWith('[')).toBe(false)
  })

  test('json format returns JSON result message', async () => {
    server.reset([textResponse('JSON output content')])

    const result = await runCLI({
      prompt: 'Say something in json',
      serverUrl: server.url,
      maxTurns: 1,
      outputFormat: 'json',
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeDefined()

    const parsed = result.parsed as Record<string, unknown>
    // Should be a result message object
    expect(parsed.type).toBe('result')
    expect(parsed.subtype).toBe('success')
    expect(typeof parsed.result).toBe('string')
    expect(parsed.result).toContain('JSON output content')
  })

  test('json format with --verbose returns array of all messages', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "verbose_test"' } },
      ]),
      textResponse('Verbose output complete'),
    ])

    const result = await runCLI({
      prompt: 'Test verbose json',
      serverUrl: server.url,
      maxTurns: 3,
      outputFormat: 'json',
      verbose: true,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeDefined()

    // With --verbose, json format returns an array of all messages
    const parsed = result.parsed as Array<Record<string, unknown>>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(1)

    // Should contain assistant messages and a result message
    const types = parsed.map((m) => m.type)
    expect(types).toContain('assistant')
    expect(types).toContain('result')
  })

  test('stream-json format returns NDJSON lines', async () => {
    server.reset([textResponse('Stream json test')])

    const result = await runCLI({
      prompt: 'Test stream json',
      serverUrl: server.url,
      maxTurns: 1,
      outputFormat: 'stream-json',
    })

    expect(result.exitCode).toBe(0)

    // Parsed should be an array of JSON objects (one per line)
    const parsed = result.parsed as Array<Record<string, unknown>>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)

    // Each entry should be a valid object with a 'type' field
    for (const entry of parsed) {
      expect(entry).toBeDefined()
      if (!entry._parseError) {
        expect(typeof entry.type).toBe('string')
      }
    }
  })

  test('stream-json contains assistant and result message types', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "stream_test"' } },
      ]),
      textResponse('Stream test complete'),
    ])

    const result = await runCLI({
      prompt: 'Test stream message types',
      serverUrl: server.url,
      maxTurns: 3,
      outputFormat: 'stream-json',
    })

    expect(result.exitCode).toBe(0)

    const parsed = result.parsed as Array<Record<string, unknown>>

    // Should contain assistant messages
    const assistantMsgs = filterMessages(parsed, 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)

    // Should contain a result message
    const resultMsg = getResultMessage(parsed)
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.type).toBe('result')
  })
})
