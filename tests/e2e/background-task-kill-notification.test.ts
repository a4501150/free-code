/**
 * Background Task Kill Notification E2E
 *
 * Regression test for the bug where pressing 'x' in BackgroundTasksDialog
 * (or its detail view) would silently swallow the killed <task-notification>.
 * killTask used to set notified:true synchronously, which caused the natural
 * completion handler's enqueueShellNotification(..., 'killed') call to
 * early-return at the duplicate-suppression guard. The LLM never learned the
 * task had been killed.
 *
 * Fix: killTask now calls enqueueShellNotification directly so the killed
 * notification reaches the next user-message body. This test exercises the
 * UI path (long-running bash → /tasks dialog → 'x' → next request body).
 *
 * See plan: "Background task UX cleanup (description, kill, scrollable shell
 * detail, live pending tail)" Change 2.
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
import {
  MockAnthropicServer,
  type RequestLogEntry,
} from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

/**
 * Concatenate every text/tool-result block of every user-role message into a
 * single string so we can grep for the embedded <task-notification> XML
 * without worrying about which block index it landed in.
 */
function userTextBlob(req: RequestLogEntry): string {
  const messages = (req.body.messages ?? []) as Array<{
    role: string
    content: unknown
  }>
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      out.push(m.content)
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (typeof block.text === 'string') out.push(block.text)
      if (typeof block.content === 'string') out.push(block.content)
      if (Array.isArray(block.content)) {
        for (const inner of block.content as Array<Record<string, unknown>>) {
          if (typeof inner.text === 'string') out.push(inner.text)
        }
      }
    }
  }
  return out.join('\n\n')
}

describe('Background task kill notification', () => {
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

  test('x-keypress in /tasks dialog enqueues killed notification', async () => {
    server.reset([
      // Turn 1: model fires a long-running bash in the background.
      toolUseResponse([
        {
          name: 'Bash',
          input: {
            command: 'sleep 120',
            description: 'kill-target',
            run_in_background: true,
          },
        },
      ]),
      // Turn 1 follow-up: model acknowledges and ends the turn.
      textResponse('Started in background.'),
      // Turn 2: the user types "ok" — the request body should carry the
      // queued <task-notification status=killed> from the dialog kill.
      textResponse('Acknowledged.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      additionalEnv: {
        // The default test env disables background tasks via
        // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, which strips
        // run_in_background from the Bash schema. Override so the model can
        // actually background the sleep.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
      },
    })
    await session.start()

    // Turn 1 — kick off the background bash. submitAndApprove handles the
    // permission prompt for `sleep 120`.
    await session.submitAndApprove('Run a long task in the background')

    // Brief pause so the LocalShellTask state machine actually registers
    // the running task before we open the dialog.
    await sleep(500)

    // Open BackgroundTasksDialog. With exactly one task running, it
    // auto-skips to the ShellDetailDialog (BackgroundTasksDialog.tsx:175).
    await session.sendLine('/tasks')
    await session.waitForText('Shell details', 10_000)

    // Press x to kill the running shell. ShellDetailDialog.handleKeyDown
    // routes 'x' to onKillShell → killShellTask → LocalShellTask.kill →
    // killTask. With the fix, killTask now enqueues the killed
    // <task-notification> directly.
    await session.sendSpecialKey('x')
    // Give the kill flow + state update + queue write a beat to settle.
    await sleep(500)
    // Close the dialog (Esc) so the prompt regains focus.
    await session.sendSpecialKey('Escape')
    await session.waitForPrompt(10_000)

    // Turn 2 — submit any user message. The queued task-notification
    // should be drained into this request body.
    await session.submitAndWaitForResponse('ok')

    const log = server.getRequestLog()
    // Locate the request whose body contains the killed task-notification.
    // Don't assume the index — depending on whether Turn 1 produced one
    // request or two (tool_use + tool_result), the killed notification
    // might land on whichever request follows the dialog kill.
    const matching = log
      .map((req, idx) => ({ req, idx, text: userTextBlob(req) }))
      .filter(
        ({ text }) =>
          /<task-notification>/i.test(text) &&
          /<status>killed<\/status>/i.test(text),
      )

    if (matching.length === 0) {
      // Surface diagnostic context — easier to debug than a bare expect.
      const summaries = log.map((req, idx) => {
        const blob = userTextBlob(req)
        const head = blob.length > 200 ? `${blob.slice(0, 200)}…` : blob
        return `  request[${idx}]: ${head}`
      })
      throw new Error(
        `No request body contained <task-notification>...<status>killed</status>.\n${summaries.join('\n')}`,
      )
    }

    expect(matching.length).toBeGreaterThan(0)
  })
})
