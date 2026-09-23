/**
 * E2E: the spinner row must stay visible for the whole busy stretch —
 * including while the assistant's text streams onto the screen. The old
 * policy hid the spinner behind streaming text ("the text IS the
 * feedback"), but each provider-side stream clear hid and re-showed the
 * row mid-turn: the row vanishing after the first complete streamed line
 * is exactly what users saw as the spinner unmounting when thinking ended
 * and the answer began.
 *
 * Probe: a delayed multi-line text response stretches the streaming
 * phase; pane captures during it must keep showing the ANIMATED title
 * row. Verbose mode makes that row always carry a "(Ns · N tokens)"
 * byline, so a title line with the byline is only ever the live spinner.
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

describe('spinner visible during streaming', () => {
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

  test('the animated spinner survives the streaming window', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: { skipDangerousModePermissionPrompt: true, verbose: true },
    })
    await session.start()

    // Multi-line stream: under the old hide-behind-text policy each
    // complete line painted re-evaluated the hide condition, so the line
    // breaks are what made the old blink observable.
    const streamText =
      Array.from(
        { length: 12 },
        (_, i) =>
          `padding line ${i} — streamed deltas stretch the stream window`,
      ).join('\n') + '\nEND OF STREAM MARKER'

    server.reset([
      // Turn 1: one task on the board.
      toolUseResponse([
        {
          name: 'TaskCreate',
          input: { subject: 'Spin through the stream', description: 'x' },
        },
      ]),
      textResponse('Board is up.'),
      // Turn 2: claim task 1 so the spinner shows the task verb, then
      // stream a long text response. The spinner must keep its animated
      // row (title + verbose byline) through the whole stream.
      toolUseResponse([
        { name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
      ]),
      withDelay(textResponse(streamText), 120),
    ])

    await session.submitAndApprove('set up the board')
    await session.waitForText('Board is up.', 60_000)

    await session.submitAndApprove('start task one', 60_000)

    // Poll the pane through the streaming phase and count frames carrying
    // the animated row: the task verb followed by the verbose
    // "(Ns · …)" byline. Pre-fix the row vanished as soon as the first
    // complete streamed line painted.
    const animatedRow = /Spin through the stream… \(/m
    let spinnerCaptures = 0
    const allPanes: string[] = []
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const pane = await session.capturePane()
      if (pane.includes('END OF STREAM MARKER')) break
      if (animatedRow.test(pane)) spinnerCaptures++
      else allPanes.push(pane)
      await new Promise(r => setTimeout(r, 60))
    }

    if (spinnerCaptures < 5) {
      console.log(
        allPanes
          .slice(-3)
          .map((p, i) => `===== miss ${i} =====\n${p}`)
          .join('\n'),
      )
    }
    // The delayed stream stretches the window to ~2s; at ~10 captures/s
    // the animated row must be on screen many times.
    expect(spinnerCaptures).toBeGreaterThanOrEqual(5)

    await session.waitForText('END OF STREAM MARKER', 30_000)
  })
})
