/**
 * Fork run_in_background E2E tests
 *
 * Forks honor run_in_background like every other agent type:
 *  - foreground (default): the fork's report is the Agent tool_result.
 *  - run_in_background: true: the tool_result is only a launch receipt; the
 *    report arrives later inside a <task-notification>.
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
import {
  MockAnthropicServer,
  type RequestLogEntry,
} from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

const SETTINGS = {
  // The harness seeds backgroundTasksEnabled: false; the fork gate needs
  // background tasks on so run_in_background stays in the Agent schema.
  backgroundTasksEnabled: true,
  forkSubagentEnabled: true,
}

function getToolResults(
  log: RequestLogEntry[],
  requestIndex: number,
): Array<{ tool_use_id: string; content: unknown }> {
  const messages = log[requestIndex].body.messages as Array<{
    role: string
    content: unknown
  }>
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return []
  return (lastUserMsg.content as Array<Record<string, unknown>>)
    .filter(c => c.type === 'tool_result')
    .map(c => ({
      tool_use_id: c.tool_use_id as string,
      content: c.content,
    }))
}

/** All user-message text (string blocks and nested text blocks) across the log. */
function collectUserText(log: RequestLogEntry[]): string {
  const out: string[] = []
  for (const entry of log) {
    const messages = entry.body.messages as Array<{
      role: string
      content: unknown
    }>
    for (const msg of messages) {
      if (msg.role !== 'user') continue
      if (typeof msg.content === 'string') {
        out.push(msg.content)
        continue
      }
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push(block.text)
        }
      }
    }
  }
  return out.join('\n\n')
}

function resultContentString(tr: { content: unknown } | undefined): string {
  if (!tr) return ''
  return typeof tr.content === 'string'
    ? tr.content
    : JSON.stringify(tr.content)
}

describe('Fork run_in_background', () => {
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

  test('foreground fork reports through the tool_result, no notification', async () => {
    server.reset([
      // Turn 1: main → foreground fork.
      toolUseResponse([
        {
          name: 'Agent',
          input: {
            description: 'foreground fork',
            prompt: 'Reply with exactly: fg-fork-report',
            subagent_type: 'fork',
          },
        },
      ]),
      // The fork's own turn.
      textResponse('fg-fork-report'),
      // Main's final turn, after receiving the report as the tool_result.
      textResponse('The fork reported fg-fork-report.'),
    ])

    session = new TmuxSession({ serverUrl: server.url, settings: SETTINGS })
    await session.start()
    await session.submitAndApprove('Fork something in the foreground', 90_000)

    const log = await waitForRequestCount(server, 3, {
      description: 'foreground fork round-trip',
    })

    // Request 1 is the fork's own request; request 2 is the main's follow-up
    // carrying the fork's report as the tool_result.
    const toolResults = getToolResults(log, 2)
    expect(toolResults.length).toBe(1)
    const content = resultContentString(toolResults[0])
    expect(content).toContain('fg-fork-report')
    expect(content).not.toContain('Async agent launched')
    // No launch receipt anywhere: it never ran in the background.
    expect(collectUserText(log)).not.toContain('<task-notification>')
  })

  test('backgrounded fork returns a launch receipt and reports via task-notification', async () => {
    server.reset([
      // Turn 1: main → backgrounded fork.
      toolUseResponse([
        {
          name: 'Agent',
          input: {
            description: 'bg fork',
            prompt: 'Reply with exactly: bg-fork-report',
            subagent_type: 'fork',
            run_in_background: true,
          },
        },
      ]),
      // The main's ack turn and the fork's own turn can race, so both get
      // the same marker text — whichever consumes which, the notification
      // still carries the marker.
      textResponse('bg-fork-report'),
      textResponse('bg-fork-report'),
      // The main's turn auto-fired by the fork's completion notification.
      textResponse('Acknowledged the notification.'),
    ])

    session = new TmuxSession({ serverUrl: server.url, settings: SETTINGS })
    await session.start()
    await session.submitAndApprove('Fork something in the background', 90_000)

    const log = await waitForRequestCount(server, 4, {
      description: 'backgrounded fork launch + completion notification',
    })

    // The tool_result is only the launch receipt — not the report. Which
    // index carries it depends on whether the fork's own request or the
    // main's ack turn reaches the server first, so scan every request.
    const allToolResults = log.flatMap((_, i) => getToolResults(log, i))
    const receipt = allToolResults
      .map(resultContentString)
      .find(s => s.includes('Async agent launched'))
    expect(receipt).toBeDefined()
    expect(receipt!).not.toContain('bg-fork-report')

    // The report arrives inside the completion notification.
    const userText = collectUserText(log)
    expect(userText).toContain('<task-notification>')
    expect(userText).toContain('bg-fork-report')
  })
})
