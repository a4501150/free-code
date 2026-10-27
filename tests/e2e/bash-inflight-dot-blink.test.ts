/**
 * E2E: the collapsed `⏺ Running 1 bash command…` row must BLINK while the
 * command executes — the dot alternates with a blank cell on the 600ms
 * clock (ToolUseLoader/useBlink). The attached/hosted pane paints this row
 * through AttachedTranscript, whose per-row shouldAnimate must reflect the
 * wire's in-flight tool ids (MessageRow's rule); wired wrong the dot sits
 * as a static ⏺ for the command's whole run — the symptom this guards.
 *
 * Probe: `sleep 5` for real in bypass mode (no dialog to interleave),
 * sample the pane CONCURRENTLY with the submit — the run is exactly the
 * window submitAndApprove blocks through — and require both blink phases.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
setDefaultTimeout(180_000)

import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import {
  createLoggingTest,
  setupE2ESuite,
  type TmuxSession,
} from './tmux-helpers'

const test = createLoggingTest(bunTest)

// The dot glyph is platform-gated (⏺ on macOS, ● elsewhere).
const DOT = /[⏺●]/
const RUNNING_ROW = /^\s*(?:[⏺●]\s+)?Running 1 bash command/m

describe('bash in-flight dot blink', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('the Running row blinks through the command run', async () => {
    server.reset([
      toolUseResponse([
        {
          name: 'Bash',
          input: { command: 'sleep 5', description: 'nap' },
        },
      ]),
      textResponse('NAP DONE'),
    ])

    session = await startSession({
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: { skipDangerousModePermissionPrompt: true },
    })

    // Sample while the turn runs: submitAndApprove only returns at idle,
    // by which point the Running row is the finalized `Ran` one.
    const sampling = (async () => {
      let dotFrames = 0
      let blankFrames = 0
      let lastPane = ''
      const seenLines = new Set<string>()
      const misses: string[] = []
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const pane = await session!.capturePane()
        lastPane = pane
        if (pane.includes('NAP DONE')) break
        const row = RUNNING_ROW.exec(pane)
        if (row) {
          // The match carries the optional dot prefix, so its presence or
          // absence IS the blink phase.
          seenLines.add(row[0])
          if (DOT.test(row[0])) dotFrames++
          else blankFrames++
        } else if (misses.length < 3) {
          misses.push(pane)
        }
        await new Promise(r => setTimeout(r, 100))
      }
      return { dotFrames, blankFrames, lastPane, misses, seenLines }
    })()

    await session.submitAndApprove('take a nap', 60_000)
    const { dotFrames, blankFrames, lastPane, misses, seenLines } =
      await sampling

    if (dotFrames < 2 || blankFrames < 2) {
      console.log(
        `dotFrames=${dotFrames} blankFrames=${blankFrames}\n` +
          [...seenLines].map(l => `row: ${JSON.stringify(l)}`).join('\n') +
          `\n===== last pane =====\n${lastPane}\n` +
          misses.map((p, i) => `===== miss ${i} =====\n${p}`).join('\n'),
      )
    }
    // sleep 5 spans ~4 off-windows at the 600ms cadence; both phases must
    // show repeatedly before the row flips to the resolved `Ran`.
    expect(dotFrames).toBeGreaterThanOrEqual(2)
    expect(blankFrames).toBeGreaterThanOrEqual(2)

    await session.waitForText('NAP DONE', 30_000)
  })
})
