/**
 * E2E: while an in-progress task exists, its title row must stay on
 * screen even while the spinner is hidden behind streaming text. The
 * spinner renders a static quiet-title row in its slot during those
 * windows (Spinner.tsx QuietTitleRow) so the live task list never loses
 * its heading.
 *
 * Probe: a delayed text response stretches the streaming phase; pane
 * captures during it must keep showing the bare quiet title row. Pre-fix
 * the spinner simply vanished there and the title went with it.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(180_000)

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import type { MockResponse } from '../helpers/sse-encoder'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

function withDelay(response: MockResponse, delayMs: number): MockResponse {
  const r = response as unknown as {
    kind: 'success'
    response: Record<string, unknown>
  }
  r.response.sseEventDelayMs = delayMs
  return response
}

describe('quiet title during streaming', () => {
  let server: MockAnthropicServer
  let session: TmuxSession | undefined

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(async () => {
    server.stop()
    if (session) await session.stop()
  })

  test('the title row survives the spinner-hidden streaming window', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: { skipDangerousModePermissionPrompt: true, verbose: true },
    })
    await session.start()

    // Visible streaming text renders complete lines only (text before the
    // last newline), so the fixture must carry line breaks — a one-line
    // stream never hides the spinner and the quiet window never opens.
    const streamText =
      Array.from(
        { length: 12 },
        (_, i) =>
          `padding line ${i} — streamed deltas hold the quiet window open`,
      ).join('\n') + '\nEND OF STREAM MARKER'

    server.reset([
      // Turn 1: one task on the board.
      toolUseResponse([
        {
          name: 'TaskCreate',
          input: { subject: 'Audit the quiet title', description: 'x' },
        },
      ]),
      textResponse('Board is up.'),
      // Turn 2: claim task 1, then stream a long text response. Text
      // streaming hides the spinner — the quiet title row must take over.
      toolUseResponse([
        { name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
      ]),
      withDelay(textResponse(streamText), 120),
    ])

    await session.submitAndApprove('set up the board')
    await session.waitForText('Board is up.', 60_000)

    await session.submitAndApprove('start task one', 60_000)

    // Poll the pane through the streaming phase and count the quiet title
    // row: the title with NO animated spinner beside it. Verbose mode
    // makes the animated row always carry a "(timer · tokens)" trailer,
    // so a bare "· <title>…" line is only ever the quiet row. Pre-fix the
    // line simply disappeared while deltas streamed.
    const quietRow = /^· Audit the quiet title…\s*$/m
    let quietCaptures = 0
    const allPanes: string[] = []
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const pane = await session.capturePane()
      if (pane.includes('END OF STREAM MARKER')) break
      if (quietRow.test(pane)) quietCaptures++
      else allPanes.push(pane)
      await new Promise(r => setTimeout(r, 60))
    }

    if (quietCaptures < 5) {
      console.log(
        allPanes
          .slice(-3)
          .map((p, i) => `===== miss ${i} =====\n${p}`)
          .join('\n'),
      )
    }
    // The delayed stream stretches the quiet window to ~2s; at ~10
    // captures/s the static row must be on screen many times.
    expect(quietCaptures).toBeGreaterThanOrEqual(5)

    await session.waitForText('END OF STREAM MARKER', 30_000)
  })
})
