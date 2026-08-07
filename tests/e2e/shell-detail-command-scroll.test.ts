/**
 * Shell detail command panel E2E
 *
 * The Shell details dialog used to hard-truncate the command at 280 chars and
 * render it as plain text above the output box, so a long multi-line bash
 * command was unreadable. It now lives in its own ScrollBox that Tab focuses,
 * sharing the pager keys with the output box.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

// 40 marker lines, well past both the old 280-char truncation and the
// 8-row command viewport. The markers are unique so we can assert which
// slice of the command is on screen. `:` is the shell no-op — the markers
// must never reach stdout, or they'd also match inside the output panel.
const MARKER_LINES = Array.from(
  { length: 40 },
  (_, i) => `: cmdmarker_${String(i).padStart(2, '0')}`,
)
const LONG_COMMAND = `${MARKER_LINES.join('\n')}\nsleep 120`

describe('Shell detail command panel', () => {
  let server: MockAnthropicServer
  let session: TmuxSession

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (session) await session.stop()
  })

  test('long command is scrollable and Tab-focusable', async () => {
    server.reset([
      toolUseResponse([
        {
          name: 'Bash',
          input: {
            command: LONG_COMMAND,
            description: 'scroll-target',
            run_in_background: true,
          },
        },
      ]),
      textResponse('Started in background.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      additionalEnv: {
        // The default test env strips run_in_background from the Bash
        // schema; override so the model can actually background this.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
      },
    })
    await session.start()

    await session.submitAndApprove('Run a long task in the background')

    // Let the LocalShellTask state machine register the running task.
    await sleep(500)

    // With exactly one task running, /tasks auto-skips to ShellDetailDialog.
    await session.sendLine('/tasks')
    await session.waitForText('Shell details', 10_000)

    const initial = await session.capturePane()

    // The command panel is scrollable, so it gets its own position footer
    // and the Tab hint appears in the byline.
    expect(initial).toContain('cmdmarker_00')
    expect(initial).toContain('of 41')
    expect(initial).toContain('switch panel')

    // Not truncated into oblivion, but only the first viewport is on screen.
    expect(initial).not.toContain('cmdmarker_39')

    // Tab moves the pager to the command panel; End walks it to the bottom.
    await session.sendSpecialKey('Tab')
    await sleep(200)
    await session.sendSpecialKey('End')
    await session.waitForText('cmdmarker_39', 10_000)

    const scrolled = await session.capturePane()
    expect(scrolled).toContain('sleep 120')
    expect(scrolled).not.toContain('cmdmarker_00')

    // Tab back: the pager now drives the output panel, so Home must leave
    // the command panel exactly where it was.
    await session.sendSpecialKey('Tab')
    await sleep(200)
    await session.sendSpecialKey('Home')
    await sleep(500)

    const afterOutputScroll = await session.capturePane()
    expect(afterOutputScroll).toContain('cmdmarker_39')
    expect(afterOutputScroll).not.toContain('cmdmarker_00')

    // Clicking a panel focuses it too. Anchor the row to the rendered
    // "Command:" label rather than a fixed offset, since everything above
    // it (logo, transcript) varies. Label, then box border, then content.
    const rows = afterOutputScroll.split('\n')
    const labelRow = rows.findIndex(r => r.includes('Command:'))
    expect(labelRow).toBeGreaterThan(-1)
    await session.sendMouseClick(10, labelRow + 3)
    await sleep(200)
    await session.sendSpecialKey('Home')
    await session.waitForText('cmdmarker_00', 10_000)

    const afterClick = await session.capturePane()
    expect(afterClick).toContain('lines 1-')
    expect(afterClick).not.toContain('cmdmarker_39')
  })
})
