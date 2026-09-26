/**
 * E2E: while parallel TaskCreate input JSON streams in, the collapsed
 * "⏺ Creating N tasks…" row must stay on screen the whole time.
 *
 * The user-visible symptom this guards: the row vanishing from the pane for
 * a frame and coming back ("blinking like a phantom"). Detected pane-level:
 * sample the terminal during the streaming window and flag any frame with
 * no Creating/Created row between frames that have one. Row RELOCATIONS in
 * the repaint trace (paint at y, erase at y+1, same frame) are legitimate —
 * the bottom-pinned block shifts as the task panel grows — so they are
 * logged, not asserted on.
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

describe('task create collapsed blink', () => {
  let server: MockAnthropicServer
  let session: TmuxSession | undefined
  let debugPath: string

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
    debugPath = join(
      await mkdtemp(join(tmpdir(), 'create-blink-')),
      'debug.txt',
    )
  })

  afterAll(async () => {
    server.stop()
    if (session) await session.stop()
  })

  test('the Creating row mounts once and updates in place', async () => {
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
      textResponse(filler),
      // Six TaskCreates whose input JSON streams in chunks, 150ms between
      // SSE events, so the collapsed row lives through ~20 stream events.
      withDelay(
        toolUseResponse(
          [1, 2, 3, 4, 5, 6].map(i => ({
            name: 'TaskCreate',
            input: {
              subject: `Blink probe task ${i} with a long enough subject`,
              description: 'streaming probe payload padding the json chunking',
            },
          })),
        ),
        150,
      ),
      textResponse('Six tasks created.'),
    ])

    await session.submitAndApprove('emit filler', 60_000)
    await session.waitForText('padding the transcript', 60_000)
    await new Promise(r => setTimeout(r, 1500))

    const turnStart = Date.now()
    await session.submitAndApprove('create six tasks', 60_000)

    // Sample the real pane during the streaming window. If the collapsed
    // row truly unmounts, some frame shows its line blank between frames
    // that show it.
    const frames: Array<{ t: number; lines: string[] }> = []
    while (Date.now() - turnStart < 30_000) {
      const pane = await session.capturePane()
      const lines = pane.split('\n')
      frames.push({ t: Date.now(), lines })
      if (lines.some(l => l.includes('Six tasks created.'))) break
      await new Promise(r => setTimeout(r, 80))
    }
    console.log(`--- pane frames sampled: ${frames.length} ---`)
    // Movement of the block is legitimate; the phantom the user sees is the
    // Creating row being GONE from the pane mid-turn. One char per frame:
    // C = present-tense Creating row visible, D = finalized Created row,
    // - = neither. A blank island (-C) inside the streaming window is the
    // blink signature.
    const presence = frames.map(f =>
      f.lines.some(l => l.includes('Creating'))
        ? 'C'
        : f.lines.some(l => l.includes('Created'))
          ? 'D'
          : '-',
    )
    console.log(`presence: ${presence.join('')}`)
    const firstC = presence.indexOf('C')
    const firstD = presence.indexOf('D')
    const activeWindow = presence.slice(
      firstC,
      firstD === -1 ? presence.length : firstD,
    )
    const blankIslands = (activeWindow.slice(1, -1).join('').match(/-C/g) ?? [])
      .length
    console.log(
      `creatingFrames=${activeWindow.filter(p => p.includes('C')).length} blankIslands=${blankIslands}`,
    )

    await session.waitForText('Six tasks created.', 60_000)
    await new Promise(r => setTimeout(r, 1000))

    const debug = await Bun.file(debugPath).text()
    const lines = debug.split('\n')

    const rowsAt = (since: number) =>
      lines.filter(line => {
        const m = line.match(/^(\S+) \[/)
        if (!m) return false
        return (
          Date.parse(m[1]!) >= since &&
          (line.includes('repaint-row') ||
            line.includes('repaint-frame') ||
            line.includes('[REPAINT] full reset') ||
            line.includes('Full reset'))
        )
      })

    const turnRows = rowsAt(turnStart)
    console.log('--- repaint rows touching the collapsed Creating line ---')
    console.log(
      turnRows
        .filter(
          l =>
            l.includes('Creating') ||
            l.includes('Created') ||
            l.includes('tasks'),
        )
        .join('\n'),
    )

    // Informational: each per-block commit moves the block one row (the
    // task panel grows below the pinned spinner), which logs a paint and an
    // erase in the same frame. That is a translation, not a blink — the
    // blink assertion is the pane-level blankIslands above.
    const creatingErases = turnRows.filter(
      l =>
        l.includes('repaint-row') &&
        /prev="[^"]*Creating/.test(l) &&
        (l.includes('next=""') || l.includes('next="" ')),
    )
    console.log(`--- Creating-row relocations: ${creatingErases.length} ---`)

    // No full-terminal reset during the streaming phase.
    const resets = turnRows.filter(
      l => l.includes('full reset') || l.includes('Full reset'),
    )
    console.log(`--- full resets: ${resets.length} ---`)

    expect(resets).toEqual([])
    // Phantom signature: any pane frame during the streaming window that
    // lost the Creating row entirely.
    expect(blankIslands).toBe(0)
  })
})
