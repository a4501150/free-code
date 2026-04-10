import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI, ensureBinaryExists } from './test-helpers'
import { textResponse } from './fixture-builders'

describe('Basic Text Responses', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    ensureBinaryExists()
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  beforeEach(() => {
    server.reset([])
  })

  test('simple text reply', async () => {
    server.reset([textResponse('Hello, world!')])

    const result = await runCLI({
      prompt: 'Say hello',
      serverUrl: server.url,
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Hello, world!')
  })

  test('multi-paragraph text', async () => {
    const longText =
      'First paragraph with some content.\n\nSecond paragraph with more details.\n\nThird paragraph wrapping up.'
    server.reset([textResponse(longText)])

    const result = await runCLI({
      prompt: 'Write paragraphs',
      serverUrl: server.url,
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('First paragraph')
    expect(result.stdout).toContain('Second paragraph')
    expect(result.stdout).toContain('Third paragraph')
  })

  test('empty text block', async () => {
    server.reset([textResponse('')])

    const result = await runCLI({
      prompt: 'Say nothing',
      serverUrl: server.url,
      maxTurns: 1,
    })

    // CLI should still complete (possibly with empty or minimal output)
    // The exit code should be 0 even with empty response
    expect(result.exitCode).toBe(0)
  })

  test('unicode and emoji preservation', async () => {
    const unicodeText = 'Here are some symbols: \u2714 \u2718 \u2605 \u2602 and CJK: \u4F60\u597D\u4E16\u754C'
    server.reset([textResponse(unicodeText)])

    const result = await runCLI({
      prompt: 'Show unicode',
      serverUrl: server.url,
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('\u4F60\u597D\u4E16\u754C')
    expect(result.stdout).toContain('\u2714')
  })

  test('large response (10k+ characters)', async () => {
    const largeText = 'A'.repeat(10_000) + ' END_MARKER'
    server.reset([textResponse(largeText)])

    const result = await runCLI({
      prompt: 'Generate large output',
      serverUrl: server.url,
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('END_MARKER')
    // Verify the full text came through (minus any formatting the CLI adds)
    expect(result.stdout.length).toBeGreaterThan(9000)
  })
})
