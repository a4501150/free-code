/**
 * E2E: with the task panel live under the spinner, a turn that streams
 * several Edit tool calls must not rewrite the full screen each time a
 * block commits. Each commit scrolls the transcript via the region-scoped
 * shift fast path (debug trace `shift-scroll k=... region=...`) and
 * repaints only the new rows; the pre-fix coalesced pass rewrote 25-31
 * of 40 rows per commit, which users see as the whole screen — task panel
 * included — blinking once per tool call.
 *
 * Setup: turn 1 creates two tasks (panel goes live, auto-expanded) and
 * Writes a file. Turn 2 streams four Edits with a slow SSE drip so each
 * tool_use block lands on its own repaint frame.
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

import { mkdtemp, writeFile } from 'node:fs/promises'
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

describe('edit in-flight panel repaint', () => {
  let server: MockAnthropicServer
  let session: TmuxSession | undefined
  let debugPath: string
  let cwdDir: string

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
    debugPath = join(
      await mkdtemp(join(tmpdir(), 'edit-repaint-')),
      'debug.txt',
    )
    cwdDir = await mkdtemp(join(tmpdir(), 'edit-repaint-cwd-'))
    await writeFile(join(cwdDir, 'a.txt'), 'alpha\nbeta\ngamma\ndelta\n')
  })

  afterAll(async () => {
    server.stop()
    if (session) await session.stop()
  })

  test('streaming Edits scroll without rewriting the screen', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      cwd: cwdDir,
      additionalArgs: [
        '--debug-file',
        debugPath,
        '--dangerously-skip-permissions',
      ],
      // Bypass mode pill is the stable idle marker (the footer swaps
      // "? for shortcuts" for task hints while the panel is expanded).
      readyText: 'bypass permissions on',
      settings: { skipDangerousModePermissionPrompt: true },
    })
    await session.start()

    const p = join(cwdDir, 'a.txt')
    server.reset([
      toolUseResponse([
        {
          name: 'TaskCreate',
          input: { subject: 'Audit repaint path', description: 'x' },
        },
        {
          name: 'TaskCreate',
          input: { subject: 'Fix the blink', description: 'y' },
        },
      ]),
      toolUseResponse([
        {
          name: 'Write',
          input: {
            file_path: p,
            content: 'alpha\nbeta\ngamma\ndelta\nepsilon\n',
          },
        },
      ]),
      textResponse('Created two tasks.'),
      withDelay(
        toolUseResponse([
          {
            name: 'Edit',
            input: { file_path: p, old_string: 'alpha', new_string: 'ALPHA' },
          },
          {
            name: 'Edit',
            input: { file_path: p, old_string: 'beta', new_string: 'BETA' },
          },
          {
            name: 'Edit',
            input: { file_path: p, old_string: 'gamma', new_string: 'GAMMA' },
          },
          {
            name: 'Edit',
            input: { file_path: p, old_string: 'delta', new_string: 'DELTA' },
          },
        ]),
        250,
      ),
      textResponse('All edits applied.'),
    ])

    await session.submitAndApprove('set up the board')
    await session.waitForText('Created two tasks.', 30_000)
    // Let turn 1's commit repaints settle so the sampled window below
    // only contains turn 2.
    await new Promise(r => setTimeout(r, 2000))

    const turnStart = Date.now()
    await session.submitAndApprove('apply the edits', 60_000)
    await session.waitForText('All edits applied.', 60_000)
    await new Promise(r => setTimeout(r, 1000))

    const debug = await Bun.file(debugPath).text()
    const lines = debug.split('\n')
    const scrolls: string[] = []
    const frames: string[] = []
    for (const line of lines) {
      const m = line.match(/^(\S+) \[/)
      if (!m || Date.parse(m[1]) < turnStart) continue
      if (line.includes('shift-scroll')) scrolls.push(line)
      if (line.includes('repaint-frame')) frames.push(line)
    }

    // The scroll fast path carried the commit frames (pre-fix: zero
    // region-scoped scrolls, every commit was a coalesced full rewrite).
    expect(scrolls.length).toBeGreaterThanOrEqual(3)

    // No frame rewrote a large majority of the 40-row screen. Pre-fix
    // commit frames coalesced 22-31 rows; legitimate turn-boundary
    // commits now repaint at most ~half.
    for (const f of frames) {
      const m = f.match(/coalesced=(\d+)/)
      if (!m) continue
      expect(Number(m[1])).toBeLessThanOrEqual(20)
    }

    // The screen survived the scroll path end-to-end (waitForText above
    // reads the live tmux pane, so a garbled screen fails there first).
  })
})
