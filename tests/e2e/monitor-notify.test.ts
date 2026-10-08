/**
 * Monitor tool E2E
 *
 * Verifies the standalone Monitor tool: the command runs detached as a
 * monitor, the tool result carries the monitor task ID, and the model
 * receives a <task-notification> with <task-type>monitor</task-type> on a
 * later auto-fired turn. Also asserts the monitor lifecycle stays on
 * BackgroundTaskList/BackgroundTaskStop (no MonitorList/MonitorStop tools)
 * and that Bash no longer exposes a monitor mode.
 *
 * Modeled on background-task-kill-notification.test.ts.
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
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { userTextBlob, waitForRequest } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

describe('Monitor tool', () => {
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

  test('monitor command notifies the model via task-notification', async () => {
    server.reset([
      // Turn 1: model starts a monitor that immediately prints one line and
      // then stays quiet (the notification fires on the changed line).
      toolUseResponse([
        {
          name: 'Monitor',
          input: {
            command: 'echo monitor-line-alpha; sleep 60',
            description: 'log-tail-probe',
            notify_interval: '1s',
          },
        },
      ]),
      // Turn 1 follow-up: model acknowledges the started monitor.
      textResponse('Monitor started.'),
      // Turn auto-fired by the monitor <task-notification>.
      textResponse('Acknowledged monitor output.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      settings: { backgroundTasksEnabled: true },
    })
    await session.start()

    await session.submitAndApprove('Watch a log for changes')

    const matching = await waitForRequest(
      server,
      req => {
        const text = userTextBlob(req)
        return (
          /<task-notification>/i.test(text) &&
          /<task-type>monitor<\/task-type>/i.test(text) &&
          /monitor-line-alpha/.test(text)
        )
      },
      {
        timeoutMs: 20_000,
        description: 'monitor task-notification request',
        onTimeout: () => {
          const summaries = server.getRequestLog().map((req, idx) => {
            const blob = userTextBlob(req)
            const head = blob.length > 3000 ? `${blob.slice(0, 3000)}…` : blob
            return `  request[${idx}]: ${head}`
          })
          return `No request body contained a monitor <task-notification>.\n${summaries.join('\n')}`
        },
      },
    )
    expect(matching).toBeDefined()

    // The tool result of the starting turn carried the monitor task ID.
    const started = server
      .getRequestLog()
      .some(req => /Monitor started with ID: mon_/.test(userTextBlob(req)))
    expect(started).toBe(true)

    // The Monitor tool is in the tool pool; lifecycle stays on the
    // BackgroundTask* pair (no MonitorList/MonitorStop), and Bash has no
    // monitor mode param.
    const first = server.getRequestLog()[0]
    const tools = (first.body.tools ?? []) as Array<{
      name: string
      input_schema?: { properties?: Record<string, unknown> }
    }>
    const toolNames = tools.map(t => t.name)
    expect(toolNames).toContain('Monitor')
    expect(toolNames).not.toContain('MonitorList')
    expect(toolNames).not.toContain('MonitorStop')
    expect(toolNames).toContain('BackgroundTaskStop')
    const bash = tools.find(t => t.name === 'Bash')
    expect(Object.keys(bash?.input_schema?.properties ?? {})).not.toContain(
      'monitor_notify_freq',
    )
  })
})
