/**
 * E2E repro: transcript text leaking into the prompt input row after a
 * background-tasks dialog round-trip (open via Shift+Down, close via Esc),
 * with a prompt suggestion ghost visible in the input and a live monitor
 * streaming output (its notifications append to the transcript behind the
 * modal, exactly like the reported failure).
 *
 * Gated behind FREECODE_LEAK_E2E=1 (diagnostic, not part of the suite).
 * FREECODE_LEAK_E2E_BIN=/path/to/cli overrides the binary under test.
 * FREECODE_LEAK_E2E_SYNC=1 fakes a DEC 2026 terminal (TERM_PROGRAM) so the
 * DECSTBM shift fast path runs, as it does in real terminals.
 */
import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(600_000)

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

const SUGGESTION = 'run the tests now'
const ROUNDS = Number(process.env.FREECODE_LEAK_E2E_ROUNDS ?? 2)

const longResponse = (tag: string): string =>
  Array.from(
    { length: 30 },
    (_, i) =>
      `${tag} line ${i}: some analysis prose that wraps across the pane width`,
  ).join('\n')

describe('input row leak after dialog round-trip', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(async () => {
    server.stop()
  })

  bunTest.skipIf(!process.env.FREECODE_LEAK_E2E)(
    'dialog round-trip leaves transcript text on the input row',
    async () => {
      const cliBinary = process.env.FREECODE_LEAK_E2E_BIN
      for (let round = 0; round < ROUNDS; round++) {
        const session = new TmuxSession({
          serverUrl: server.url,
          additionalArgs: [
            '--dangerously-skip-permissions',
            '--debug-file',
            join(await mkdtemp(join(tmpdir(), 'leak-e2e-')), 'debug.txt'),
          ],
          readyText: 'bypass permissions on',
          // Fakes a DEC 2026-capable terminal: enables the DECSTBM shift
          // fast path real terminals exercise (default screen-256color
          // TERM disables it).
          ...(process.env.FREECODE_LEAK_E2E_SYNC
            ? { additionalEnv: { TERM_PROGRAM: 'iTerm.app' } }
            : {}),
          settings: {
            skipDangerousModePermissionPrompt: true,
            backgroundTasksEnabled: true,
            promptSuggestions: true,
            promptSuggestionEnabled: true,
            speculationEnabled: false,
          },
          ...(cliBinary ? { cliBinary } : {}),
        })
        await session.start()

        try {
          // Turn 1: arm a monitor that emits a line every 2s for ~24s, so
          // monitor notifications keep appending to the transcript while
          // the dialog is open.
          server.reset([
            toolUseResponse([
              {
                name: 'Bash',
                input: {
                  command:
                    'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "monitor tick $i"; sleep 2; done',
                  monitor_notify_freq: '3s',
                },
              },
            ]),
            textResponse('Monitor armed.'),
            // Suggestion fork after turn 1: filtered (evaluative).
            textResponse('looks good'),
            // Turn 2: long response to push the transcript past the
            // viewport so the virtual message list actively windows.
            textResponse(longResponse('Analysis')),
            // Suggestion fork after turn 2.
            textResponse(SUGGESTION),
            // Monitor-notice wake-ups and their forks, plenty of slack.
            ...Array.from({ length: 12 }, () => [
              textResponse('Noted the monitor output.'),
              textResponse('looks good'),
            ]).flat(),
          ])

          await session.sendLine('watch the monitor')
          await session.waitForText('Monitor armed.', 60_000)

          await session.sendLine('analyze the codebase')
          await session.waitForText('Analysis line 29', 60_000)

          // Wait for a monitor notification to land in the transcript.
          await session.waitForText('Background monitor', 60_000)
          // Wait for the suggestion ghost to show in the input row.
          await session.waitForText(SUGGESTION, 60_000)

          for (let i = 0; i < 6; i++) {
            if (i % 2 === 0) {
              // Dialog round-trip: Shift+Down opens the tasks dialog.
              await session.sendSpecialKey('S-Down')
              await session.waitForText('details', 30_000)
            } else {
              // Agent-view round-trip: Down selects the footer tasks pill,
              // Enter drills into the monitor transcript view.
              await session.sendSpecialKey('Down')
              await new Promise(r => setTimeout(r, 300))
              await session.sendSpecialKey('Enter')
              await new Promise(r => setTimeout(r, 1500))
            }
            // Linger while monitor output streams and its notification
            // appends to the transcript behind the view.
            await new Promise(r => setTimeout(r, 4000))
            await session.sendSpecialKey('Escape')
            // Older builds leak Escape through the dialog into the prompt,
            // which opens the Rewind overlay — dismiss it if present.
            for (let t = 0; t < 20; t++) {
              await new Promise(r => setTimeout(r, 500))
              const pane = await session.capturePane()
              if (pane.includes('Rewind')) {
                await session.sendSpecialKey('Escape')
                continue
              }
              if (pane.includes('to manage')) break
            }
            await new Promise(r => setTimeout(r, 500))

            const after = await session.capturePane()
            const afterLines = after.split('\n')
            const inputIdx = afterLines.findLastIndex(l =>
              l.trimStart().startsWith('❯'),
            )
            const inputLine = inputIdx >= 0 ? afterLines[inputIdx]! : ''
            // The input row must contain nothing but the prompt (plus an
            // optional suggestion ghost). Any transcript text on it leaks.
            const cleaned = inputLine
              .replace('❯', '')
              .replace(SUGGESTION, '')
              .trim()
            if (cleaned !== '') {
              console.log(`=== LEAK in round ${round} iteration ${i} ===`)
              console.log(after)
              console.log(`=== INPUT ROW: ${JSON.stringify(inputLine)}`)
              expect(cleaned).toBe('')
            }
          }
        } finally {
          await session.stop()
        }
      }
      expect(true).toBe(true)
    },
  )
})
