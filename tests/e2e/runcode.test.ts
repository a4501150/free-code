/**
 * RunCode code-mode E2E (compiled binary + mock Anthropic server).
 *
 * A stdio MCP server (runcode-mcp-server.mjs) connects as user-scope server
 * `srv`. The MCP tool must NOT ride the request's tools[] array; the model
 * reaches it as a function import inside a RunCode script. Assertions use the
 * mock server's request log (tools[] exposure + tool_result content), not the
 * pane. This also re-validates the Bun.Transpiler + AsyncFunction loader in
 * the bytecode-compiled binary end to end.
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
setDefaultTimeout(120_000)
import { join } from 'node:path'
import {
  MockAnthropicServer,
  type RequestLogEntry,
} from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

const SCRIPT = [
  `import { echo } from "mcp/srv";`,
  `console.log("in-script");`,
  `const r = await echo({ msg: "hi" });`,
  `console.log("got", r);`,
].join('\n')

function lastToolResults(
  log: RequestLogEntry[],
  requestIndex: number,
): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
  const messages = log[requestIndex].body.messages as Array<{
    role: string
    content: unknown
  }>
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  const content = lastUserMsg?.content
  if (!Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter(c => c.type === 'tool_result')
    .map(c => c as never)
}

function contentString(block: { content: unknown } | undefined): string {
  if (!block) return ''
  return typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content)
}

function requestToolNames(entry: RequestLogEntry): string[] {
  const tools = entry.body.tools as Array<{ name: string }> | undefined
  return (tools ?? []).map(t => t.name)
}

describe('RunCode code-mode E2E', () => {
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

  test('MCP tool stays out of tools[] and runs via a scripted call', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      settings: {
        mcpServers: {
          srv: {
            type: 'stdio',
            command: process.execPath, // the bun running the test harness
            args: [join(import.meta.dirname, 'runcode-mcp-server.mjs')],
          },
        },
      },
    })
    await session.start()

    // MCP connect is async and can land after the first turn; run a warm-up
    // turn so the scripted turn deterministically sees the connected server.
    server.reset([textResponse('hi')])
    await session.submitAndApprove('Warm up')
    await waitForRequestCount(server, 1, { description: 'warm-up request' })
    await Bun.sleep(1000)

    server.reset([
      toolUseResponse([
        { name: 'RunCode', input: { code: SCRIPT, title: 'run echo' } },
      ]),
      textResponse('done'),
    ])
    await session.submitAndApprove('Echo hi through the script')
    const log = await waitForRequestCount(server, 2, {
      description: 'RunCode scripted tool_result request',
    })

    // Exposure: RunCode is in the request's tools[]; the cataloged MCP tool
    // never rides the array in any request of the session.
    for (const entry of log) {
      const names = requestToolNames(entry)
      expect(names).toContain('RunCode')
      expect(names.filter(n => n.startsWith('mcp__'))).toEqual([])
    }

    // The catalog delta reminder reached the model (any turn's messages).
    const allText = JSON.stringify(log.map(e => e.body.messages))
    expect(allText).toContain('New MCP servers are connected')
    expect(allText).toContain('callable as functions from a RunCode script')

    const results = lastToolResults(log, 1)
    expect(results.length).toBe(1)
    expect(results[0].is_error).not.toBe(true)
    const text = contentString(results[0])
    expect(text).toContain('[1] mcp__srv__echo')
    expect(text).toContain('echo:hi')
    expect(text).toContain('in-script')
    expect(text).toContain('got echo:hi')
  })
})
