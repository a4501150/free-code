/**
 * E2E: the headered task panel replaces the spinner at the turn boundary.
 *
 * Guards the official-CC swap: while the turn runs, the panel renders flush
 * under the spinner WITHOUT its "N tasks (…)" header; when the turn settles,
 * the spinner unmounts and the standalone panel (header + rows) takes its
 * slot above the prompt. Pane-level assertions only.
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

describe('task panel idle header', () => {
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

  test('panel header appears when the turn ends and hides while the next turn streams', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      additionalArgs: [
        '--dangerously-skip-permissions',
        '--debug-file',
        join(await mkdtemp(join(tmpdir(), 'idle-header-')), 'debug.txt'),
      ],
      readyText: 'bypass permissions on',
      settings: { skipDangerousModePermissionPrompt: true },
    })
    await session.start()

    server.reset([
      // Turn 1: one pending task on the board.
      toolUseResponse([
        {
          name: 'TaskCreate',
          input: {
            subject: 'Idle panel probe task',
            description: 'one pending task to keep the panel from auto-hiding',
          },
        },
      ]),
      textResponse('Board is up.'),
      // Turn 2: claim task 1 (activeForm becomes the spinner verb), then
      // stream a delayed multi-line response to stretch the in-flight window.
      toolUseResponse([
        {
          name: 'TaskUpdate',
          input: {
            taskId: '1',
            status: 'in_progress',
            activeForm: 'Polishing the widget',
          },
        },
      ]),
      withDelay(
        textResponse(
          Array.from(
            { length: 12 },
            (_, i) => `padding line ${i} — streamed deltas stretch the window`,
          ).join('\n') + '\nEND OF STREAM MARKER',
        ),
        120,
      ),
    ])

    await session.submitAndApprove('create a task', 60_000)
    await session.waitForText('Board is up.', 60_000)

    // Turn over, spinner unmounted (300ms grace): the standalone headered
    // panel must be on the pane — the panel replaced the spinner. The task
    // stays pending, so the store's all-completed hide never arms.
    await session.waitForText('1 tasks (0 done, 1 open)', 15_000)
    const idlePane = await session.capturePane()
    expect(idlePane).toContain('Idle panel probe task')

    await session.submitAndApprove('start task one', 60_000)

    // Poll through the streaming phase. Frames carrying the spinner (its
    // verb is the claimed task's activeForm) prove the turn is in flight —
    // none of them may show the idle header row, and enough of them must
    // exist that the swap under test is not a sampling artifact.
    let spinnerCaptures = 0
    let headerDuringSpinner = 0
    const misses: string[] = []
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const pane = await session.capturePane()
      if (pane.includes('END OF STREAM MARKER')) break
      if (pane.includes('Polishing the widget…')) {
        spinnerCaptures++
        if (pane.includes('1 tasks (')) headerDuringSpinner++
      } else {
        misses.push(pane)
      }
      await new Promise(r => setTimeout(r, 60))
    }

    if (spinnerCaptures < 5) {
      console.log(
        misses
          .slice(-3)
          .map((p, i) => `===== miss ${i} =====\n${p}`)
          .join('\n'),
      )
    }
    expect(spinnerCaptures).toBeGreaterThanOrEqual(5)
    expect(headerDuringSpinner).toBe(0)

    await session.waitForText('END OF STREAM MARKER', 30_000)

    // Turn settled again: the headered panel is back, now reporting the
    // in-progress task.
    await new Promise(r => setTimeout(r, 1000))
    await session.waitForText('1 tasks (0 done, 1 in progress, 0 open)', 15_000)
  })
})
