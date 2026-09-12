/**
 * E2E: the thinking overlay -> committed "thought for Xs" swap and live
 * task-list updates must scroll the screen with the shift fast path
 * (debug trace `shift-scroll k=...`) instead of rewriting every visible
 * row. A full-screen coalesced rewrite is what users see as a sweep on
 * terminals that paint partial writes (Apple Terminal, tmux).
 *
 * Setup: turn 1 creates two tasks (panel goes live under the spinner,
 * auto-expanded). Turn 2 streams a delayed thinking block, mutates the
 * panel via TaskUpdate, then streams a second thinking block whose commit
 * performs the overlay swap. sseEventDelayMs stretches the stream so the
 * overlay phases land on distinct frames.
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

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import type { MockResponse } from '../helpers/sse-encoder'
import {
  thinkingToolUseResponse,
  textResponse,
} from '../helpers/fixture-builders'
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

describe('thinking swap repaint E2E', () => {
  let server: MockAnthropicServer
  let session: TmuxSession | undefined
  let debugPath: string

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
    debugPath = join(
      await mkdtemp(join(tmpdir(), 'swap-repaint-')),
      'debug.txt',
    )
  })

  afterAll(async () => {
    server.stop()
    if (session) await session.stop()
  })

  test('shift fast path carries the swap frames', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      additionalArgs: ['--debug-file', debugPath],
      // Footer swaps "? for shortcuts" for task hints while the panel is
      // expanded; the mode pill is a stable idle marker instead.
      readyText: 'manual mode on',
    })
    await session.start()

    const longThinking = 'Considering the plan and what it implies. '.repeat(14)
    server.reset([
      thinkingToolUseResponse('First, the setup tasks.', [
        {
          name: 'TaskCreate',
          input: { subject: 'Audit repaint path', description: 'x' },
        },
        {
          name: 'TaskCreate',
          input: { subject: 'Fix the swap', description: 'y' },
        },
      ]),
      textResponse('Created two tasks.'),
      // Turn 2 request 1: streamed thinking, then a TaskUpdate that
      // mutates the live panel.
      withDelay(
        thinkingToolUseResponse(longThinking, [
          {
            name: 'TaskUpdate',
            input: { taskId: '1', status: 'in_progress' },
          },
        ]),
        120,
      ),
      // Turn 2 request 2: streamed thinking; the overlay swaps to its
      // committed row when this message lands.
      withDelay(
        {
          kind: 'success',
          response: {
            content: [
              { type: 'thinking', thinking: longThinking, signature: 'sig' },
              { type: 'text', text: 'Swap done. Final answer here.' },
            ],
            stop_reason: 'end_turn',
          },
        } as unknown as MockResponse,
        120,
      ),
    ])

    await session.submitAndApprove('make a plan')
    await session.waitForText('Created two tasks.', 30_000)

    await session.submitAndApprove('continue')
    await session.waitForText('Swap done. Final answer here.', 60_000)
    await new Promise(r => setTimeout(r, 1000))

    const debug = await readFile(debugPath, 'utf8')
    const lines = debug.split('\n')

    // The screen survived the scroll path end-to-end (waitForText above
    // reads the live tmux pane, so a garbled screen fails there first).

    const scrollLines = lines.filter(l => l.includes('shift-scroll'))
    expect(scrollLines.length).toBeGreaterThanOrEqual(2)

    // Every frame that took the scroll path must repaint a fraction of the
    // screen, not all of it. Pre-fix these same frames rewrote 23-30 rows.
    for (let i = 0; i < scrollLines.length; i++) {
      const idx = lines.indexOf(scrollLines[i])
      for (let j = idx + 1; j < Math.min(idx + 12, lines.length); j++) {
        const m = lines[j].match(/repaint-frame .*coalesced=(\d+)/)
        if (!m) continue
        expect(Number(m[1])).toBeLessThanOrEqual(16)
        break
      }
    }
  })
})
