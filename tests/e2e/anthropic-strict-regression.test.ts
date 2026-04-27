/**
 * Reproduces the Anthropic strict-tool regression introduced by b767110.
 * Captures the tool schema sent in the first /v1/messages request and
 * checks for the strict-shape transform that breaks Anthropic's strict-mode
 * limits (no minimum/maximum, 24 optional params total, 16 anyOf params).
 */
import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

setDefaultTimeout(60_000)
const test = createLoggingTest(bunTest)

describe('Anthropic strict regression', () => {
  let server: MockAnthropicServer
  let session: TmuxSession

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (session) await session.stop()
  })

  test('Anthropic request: tool schemas should NOT be strict-transformed', async () => {
    server.reset([textResponse('hello')])

    session = new TmuxSession({ serverUrl: server.url })
    await session.start()
    await session.submitAndWaitForResponse('hi')

    const log = server.getRequestLog()
    expect(log.length).toBeGreaterThanOrEqual(1)
    const tools = (log[0].body.tools ?? []) as Array<{
      name: string
      strict?: boolean
      input_schema?: Record<string, unknown>
    }>

    const readTool = tools.find(t => t.name === 'Read')
    expect(readTool).toBeDefined()

    // REGRESSION ASSERTIONS: For Anthropic, broad strict transform must NOT
    // apply. Anthropic strict mode 400s on minimum/maximum/etc., on schemas
    // wider than ~16 anyOf params, and on >20 strict tools per request.
    //
    // (`additionalProperties: false` is zod-v4's default for `z.object()` —
    // pre-existing and accepted by Anthropic. Not part of the regression.)
    expect(readTool!.strict).not.toBe(true)

    // No anyOf-with-null widening (the strict transform's signature shape).
    const offset = (
      readTool!.input_schema!.properties as Record<string, unknown>
    ).offset
    expect(JSON.stringify(offset)).not.toContain('"type":"null"')

    // Optional fields must NOT be added to `required`.
    const required =
      (readTool!.input_schema as { required?: string[] }).required ?? []
    expect(required).toContain('file_path')
    expect(required).not.toContain('offset')
    expect(required).not.toContain('limit')

    // structured-outputs beta should not be sent by default for Anthropic
    // (no strict tools means the beta is dead weight + a cache differentiator).
    const betaHeader = log[0].headers['anthropic-beta'] ?? ''
    expect(betaHeader).not.toContain('structured-outputs-2025-12-15')
  })
})
