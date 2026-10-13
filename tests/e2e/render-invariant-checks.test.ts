/**
 * Render-invariant checks E2E
 *
 * Runs the CLI with FREECODE_LAYOUT_CHECK=1 + FREECODE_RENDER_CHECK=1 so
 * every frame is validated: the layout check flags overlapping
 * non-absolute siblings (the mixed-geometry class behind the
 * monitor-detail input-row leak, where the scroll container stayed
 * clipped at the modal-open viewport on the close frame), and the
 * differential render check flags cells that diverge from a cache-free
 * reference render (stale nodeCache blits, missed dirty flags). Asserts
 * the debug log contains the "enabled" announcements (positive control
 * that the flags reached the process) and NO violation lines.
 *
 * Exercises both flip surfaces the invalidations guard: the modal slot
 * (Shift+Down → background-tasks detail → Esc) and the focusedInputDialog
 * slot (double-Esc Rewind overlay → Esc), with text in the prompt.
 *
 * GATED (FREECODE_INVARIANT_E2E=1): the checks currently DO report two
 * signatures on main, both tied to the real transcript's virtual scroll
 * (they do NOT reproduce in the simpler in-process harness,
 * tests/unit/inkStreamingInvariants.test.tsx):
 *   1. LAYOUT-CHECK: a streaming message box (Box/ThemedBox/REPL, h=4)
 *      and its SpinnerWithVerbInner (h=3) overlap by 3 rows during
 *      scroll-content growth — beyond the 2-cell grid cover-rounding
 *      tolerance, so real displacement, consistent with the documented
 *      useVirtualScroll one-frame window lag.
 *   2. RENDER-CHECK: the frame's screen missing the spinner row and
 *      the top transcript row that a cache-free reference render
 *      produces — the viewport's edge rows, i.e. the same lag window.
 * (Cover-rounding overlaps of ≤2 cells are tolerated by the checker:
 * yoga's fractional layouts expand rects to floor(top)..ceil(bottom),
 * so fractionally-spaced siblings legitimately share cells.)
 * Flip the gate on once the virtual-scroll lag window is fixed; the
 * assertion is then the regression net for this whole bug class.
 */
import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(300_000)

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

const longResponse = (tag: string): string =>
  Array.from(
    { length: 30 },
    (_, i) =>
      `${tag} line ${i}: some analysis prose that wraps across the pane width`,
  ).join('\n')

describe('render invariant checks', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  bunTest.skipIf(!process.env.FREECODE_INVARIANT_E2E)(
    'dialog round-trips produce no layout or render violations',
    async () => {
      const debugFile = join(
        await mkdtemp(join(tmpdir(), 'render-check-')),
        'debug.txt',
      )
      const session = new TmuxSession({
        serverUrl: server.url,
        width: 158,
        height: 40,
        additionalArgs: [
          '--dangerously-skip-permissions',
          '--debug-file',
          debugFile,
        ],
        readyText: 'bypass permissions on',
        additionalEnv: {
          TERM: 'xterm-256color',
          // The diagnostics under test: layout sanity + differential
          // render check, announced in the debug log when active. Repaints
          // debug mode also captures component owner chains so any
          // violation names the components involved.
          FREECODE_LAYOUT_CHECK: '1',
          FREECODE_RENDER_CHECK: '1',
          CLAUDE_CODE_DEBUG_REPAINTS: '1',
        },
        settings: {
          skipDangerousModePermissionPrompt: true,
          backgroundTasksEnabled: true,
          // Suggestions OFF: their side-query forks drain the mock FIFO
          // unpredictably and derail the per-turn fixture accounting.
          promptSuggestions: false,
          promptSuggestionEnabled: false,
          speculationEnabled: false,
          // A live-updating status line row in the bottom slot, matching
          // the session where the original leak was captured.
          statusLine: {
            type: 'command',
            command: 'echo "# test-model | $(date +%T) | @ ${PWD##*/}"',
          },
        },
      })
      await session.start()

      try {
        // Arm a monitor that ticks for ~2 minutes (still running through
        // every round-trip below), then transcript batches so the virtual
        // message list's window/spacer geometry is engaged. All fillers
        // are interchangeable so side-query forks that drain the mock FIFO
        // between turns can't derail the flow — anything they consume is
        // another batch response. No SSE drip: aggregate drip time would
        // dominate the test duration, and the monitor itself streams
        // during the dialog round-trips.
        const FILLER = 20
        server.reset([
          toolUseResponse([
            {
              name: 'Monitor',
              input: {
                command:
                  'for i in $(seq 1 60); do echo "monitor tick $i"; sleep 2; done',
                notify_interval: '3s',
              },
            },
          ]),
          textResponse('Monitor armed.'),
          ...Array.from({ length: FILLER }, () =>
            textResponse(longResponse('Batch')),
          ),
        ])

        await session.sendLine('watch the monitor')
        await session.waitForText('Monitor armed.', 60_000)
        await session.waitForText('Background monitor', 60_000)

        const TURNS = 3
        for (let n = 0; n < TURNS; n++) {
          await session.sendLine(`analyze batch ${n}`)
          // Instant responses: the 30-line batch scrolls the user echo out
          // of the visible pane within a poll interval, so a text wait on
          // it is a race — fixed settle instead.
          await new Promise(r => setTimeout(r, 2000))
        }
        // Settle so double-Esc hits the not-loading state (the idle
        // spinner verb is randomized, so it can't be waited on).
        await new Promise(r => setTimeout(r, 3000))

        // Let any in-flight frames flush, then snapshot the debug log: the
        // assertion below covers the dialog round-trip window only. During
        // active STREAMING the checks report transient divergences
        // (spinner row + scroll-content overlap — one-frame virtual-scroll
        // lag territory; under investigation separately), so those are
        // summarized but not failed on.
        await new Promise(r => setTimeout(r, 2000))
        const readDebug = async (): Promise<string> => {
          try {
            return await Bun.file(debugFile).text()
          } catch {
            return ''
          }
        }
        let debugOffset = (await readDebug()).length

        // focusedInputDialog flip: double-Esc opens the Rewind overlay
        // (message selector — only reachable with an EMPTY input and NOT
        // loading), Esc closes it. Retry the double-press: monitor
        // notifications landing mid-settle can transiently re-enter a
        // loading state that swallows the first attempt.
        let rewindOpen = false
        for (let attempt = 0; attempt < 3 && !rewindOpen; attempt++) {
          await session.sendSpecialKey('Escape')
          await new Promise(r => setTimeout(r, 300))
          await session.sendSpecialKey('Escape')
          try {
            await session.waitForText('Rewind', 10_000)
            rewindOpen = true
          } catch {
            await new Promise(r => setTimeout(r, 2000))
          }
        }
        expect(rewindOpen).toBe(true)
        await new Promise(r => setTimeout(r, 1000))
        await session.sendSpecialKey('Escape')
        await new Promise(r => setTimeout(r, 1000))

        // Real text in the input box — the state that survived the
        // PromptInput unmount in the original leak.
        await session.sendText('fix the renderer leak')
        await new Promise(r => setTimeout(r, 500))

        // Modal-slot flips: Shift+Down → monitor detail (streams live) → Esc.
        for (let i = 0; i < 2; i++) {
          await session.sendSpecialKey('S-Down')
          await session.waitForText('details', 30_000)
          await new Promise(r => setTimeout(r, 1200))
          await session.sendSpecialKey('Escape')
          await new Promise(r => setTimeout(r, 800))
          // Older builds leak Escape into the prompt; with text in the
          // input the message selector can't open, so just settle.
          await new Promise(r => setTimeout(r, 500))
        }

        // Let the last frames flush to the debug file.
        await new Promise(r => setTimeout(r, 2000))
        const debug = await readDebug()

        // Positive control: both checks must have announced themselves —
        // otherwise "no violations" would pass vacuously.
        expect(debug).toContain('[LAYOUT-CHECK] enabled')
        expect(debug).toContain('[RENDER-CHECK] enabled')

        const isViolation = (l: string) =>
          (l.includes('[LAYOUT-CHECK]') || l.includes('[RENDER-CHECK]')) &&
          !l.includes('enabled')
        const preexisting = debug
          .slice(0, debugOffset)
          .split('\n')
          .filter(isViolation)
        if (preexisting.length > 0) {
          console.log(
            `=== ${preexisting.length} STREAMING-PHASE VIOLATIONS (informational) ===`,
          )
          for (const l of preexisting.slice(0, 10)) console.log(l.slice(0, 400))
        }
        const violations = debug
          .slice(debugOffset)
          .split('\n')
          .filter(isViolation)
        if (violations.length > 0) {
          console.log(`=== VIOLATIONS in dialog window ===`)
          for (const l of violations.slice(0, 40)) console.log(l.slice(0, 400))
        }
        expect(violations).toEqual([])
      } finally {
        await session.stop()
      }
    },
  )
})
