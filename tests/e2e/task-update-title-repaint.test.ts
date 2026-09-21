/**
 * E2E: task-store updates (TaskCreate on an empty board, TaskUpdate while
 * the panel is live) must not repaint the spinner title row. The panel
 * itself reconciles row-wise; the frames around a store update should
 * touch only panel rows (state markers) and the rows the transcript
 * commit scrolls in — never a full reset, never a coalesced rewrite of
 * the title row.
 *
 * The user-visible symptom this guards: the title row ("* <verb>… (Ns ·
 * tokens)") blinking — being erased and rewritten — whenever the model
 * issues a TaskCreate/TaskUpdate.
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

describe('task store update title repaint', () => {
  let server: MockAnthropicServer
  let session: TmuxSession | undefined
  let debugPath: string

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
    debugPath = join(
      await mkdtemp(join(tmpdir(), 'title-repaint-')),
      'debug.txt',
    )
  })

  afterAll(async () => {
    server.stop()
    if (session) await session.stop()
  })

  test('creating and updating tasks leaves the title row alone', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      additionalArgs: [
        '--debug-file',
        debugPath,
        '--dangerously-skip-permissions',
      ],
      additionalEnv: { CLAUDE_CODE_DEBUG_REPAINTS: '1' },
      readyText: 'bypass permissions on',
      settings: { skipDangerousModePermissionPrompt: true },
    })
    await session.start()

    const filler = Array.from(
      { length: 40 },
      (_, i) => `filler line ${i} padding the transcript below the viewport`,
    ).join('\n')

    server.reset([
      // Turn 1: a long tail of text pushes the transcript past the
      // viewport so the spinner/task-panel block is bottom-pinned (the
      // regime of a real long session) for every later turn.
      textResponse(filler),
      // Turn 2: empty board → five TaskCreates drip in. Each creation
      // grows the panel while the transcript scroll-follows under a live
      // spinner.
      withDelay(
        toolUseResponse(
          [1, 2, 3, 4, 5].map(i => ({
            name: 'TaskCreate',
            input: {
              subject: `Panel row ${i}`,
              description: 'x',
            },
          })),
        ),
        200,
      ),
      textResponse('Board is up.'),
      // Turn 3: TaskUpdate in_progress then completed on task 1; the rest
      // stay pending so the panel remains live through the whole turn.
      withDelay(
        toolUseResponse([
          {
            name: 'TaskUpdate',
            input: { taskId: '1', status: 'in_progress' },
          },
          {
            name: 'TaskUpdate',
            input: { taskId: '1', status: 'completed' },
          },
        ]),
        300,
      ),
      textResponse('Task one done.'),
    ])

    const fillerStart = Date.now()
    await session.submitAndApprove('emit filler', 60_000)
    await session.waitForText('padding the transcript', 60_000)
    await new Promise(r => setTimeout(r, 1500))

    const turn1Start = Date.now()
    await session.submitAndApprove('set up the board')
    await session.waitForText('Board is up.', 60_000)
    await new Promise(r => setTimeout(r, 1500))

    const turn2Start = Date.now()
    await session.submitAndApprove('start task one', 60_000)
    await session.waitForText('Task one done.', 60_000)
    await new Promise(r => setTimeout(r, 1000))

    const debug = await Bun.file(debugPath).text()
    const lines = debug.split('\n')

    const framesAt = (since: number, until = 0) =>
      lines.filter(line => {
        const m = line.match(/^(\S+) \[/)
        if (!m) return false
        const t = Date.parse(m[1])
        if (t < since || (until && t >= until)) return false
        return (
          line.includes('repaint-frame') ||
          line.includes('repaint-row') ||
          line.includes('shift-scroll') ||
          line.includes('[REPAINT] full reset') ||
          line.includes('Full reset')
        )
      })

    // Observation: dump the frame trace for each turn.
    console.log('--- filler (pinned regime established) ---')
    console.log(framesAt(fillerStart, turn1Start).join('\n'))
    console.log('--- turn 2 (task creates, panel mounts pinned) ---')
    console.log(framesAt(turn1Start, turn2Start).join('\n'))
    console.log('--- turn 3 (task updates, scroll-follow live) ---')
    console.log(framesAt(turn2Start).join('\n'))

    // No full-terminal reset (the worst blink) in either turn.
    const resets = [...framesAt(turn1Start), ...framesAt(turn2Start)].filter(
      l => l.includes('full reset') || l.includes('Full reset'),
    )
    expect(resets).toEqual([])

    const turn2End = Date.now()

    // The title blink signature: a repaint-row detail whose PREVIOUS
    // content is the spinner verb row (glyph + verb + …) — an on-screen
    // title row rewritten wholesale (coalesced). Pre-fix, every
    // scroll-follow commit frame dragged the pinned spinner row into the
    // shift region and coalesced it (15+ per turn). Legitimate rewrites:
    // at most one per TaskCreate (the growing panel relocates the block
    // by one row — a real move), plus the unmount at each turn end.
    // Updates change no heights, so the updates turn must not move it.
    const titleCoalesced = (window: string[]) =>
      window.filter(line => {
        if (!line.includes('repaint-row') || !line.includes('coalesced=true'))
          return false
        const prev = line.match(/prev="([^"]*)"/)
        return !!prev && /^[·✢✳✶✻✽*] .*\u2026/.test(prev[1]!)
      })
    for (const [label, window, budget] of [
      ['turn 2 (creates)', framesAt(turn1Start, turn2Start), 6],
      ['turn 3 (updates)', framesAt(turn2Start, turn2End), 1],
    ] as const) {
      const hits = titleCoalesced(window)
      if (hits.length > budget) {
        throw new Error(
          `${label}: spinner title row rewritten wholesale ${hits.length}× (> ${budget}) — ${hits
            .map(h => h.slice(24))
            .join('\n')}`,
        )
      }
    }

    // The scroll fast path still carried the commit frames (the fix
    // shrinks the region, it does not disable the scroll).
    const scrolls = framesAt(turn2Start).filter(l => l.includes('shift-scroll'))
    expect(scrolls.length).toBeGreaterThanOrEqual(1)
  })
})
