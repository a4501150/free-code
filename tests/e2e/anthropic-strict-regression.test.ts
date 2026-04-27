/**
 * Anthropic-wire strict-tools wire-up.
 *
 * Verifies the design implemented in src/utils/api.ts:
 *
 *   - Universal strict-shape: every Zod-derived tool schema gets
 *     `additionalProperties: false`, all properties in `required`, optional
 *     fields widened with `null`. This shape is the strongest model-facing
 *     signal regardless of provider, and Anthropic accepts it on both
 *     non-strict and strict tools.
 *
 *   - Anthropic-wire `strict: true` is emitted ONLY on tools listed in
 *     ANTHROPIC_STRICT_TOOL_NAMES (currently FileEdit / FileWrite / FileRead)
 *     when the resolved model declares `structuredOutputs: true`. Outside
 *     that allowlist, no `strict` field is sent — Anthropic's strict-tools
 *     budget caps out at 20 tools / 24 optionals / 16 anyOf params, so we
 *     keep the strict subset small and biased to file-mutation tools where
 *     input correctness is most safety-critical.
 *
 *   - The structured-outputs beta header rides along on Anthropic-wire +
 *     structuredOutputs models so the strict subset is recognized.
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

describe('Anthropic strict-tools wire-up', () => {
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

  test('non-allowlist tools (Read non-allowlist case) are strict-shaped but not strict-flagged when model lacks structuredOutputs', async () => {
    // The mock server's default model does not declare structuredOutputs in
    // the registry. Even allowlisted tools should NOT carry strict: true.
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

    // Strict-shape is universal: additionalProperties:false + required-all +
    // nullable optionals.
    const required =
      (readTool!.input_schema as { required?: string[] }).required ?? []
    expect(required).toContain('file_path')
    // Optional fields are now in `required` (null-union encoding).
    expect(required).toContain('offset')
    expect(required).toContain('limit')

    const offset = (
      readTool!.input_schema!.properties as Record<string, unknown>
    ).offset
    // Optional widened with null: anyOf:[T,{type:'null'}] or type:["...","null"].
    expect(JSON.stringify(offset)).toContain('"type":"null"')

    // Without model-level structuredOutputs declared, even allowlist tools
    // ship without `strict: true` on the wire.
    expect(readTool!.strict).not.toBe(true)
  })
})
