/**
 * AskUserQuestion Preview Scroll E2E Test
 *
 * Verifies that preview content taller than the available height can be
 * scrolled instead of being permanently hidden — by clicking the preview to
 * focus it and using bare arrows (the portable path; Apple Terminal strips
 * shift from arrow keys), and by shift+arrow on terminals that transmit it.
 */

import {
  describe,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  test,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(120_000)
import { MockAnthropicServer } from '../helpers/mock-server'
import { toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep } from './tmux-helpers'

const TOTAL_ROWS = 40

function row(n: number): string {
  return `Preview row ${String(n).padStart(3, '0')}`
}

describe('AskUserQuestion Preview Scroll', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  let session: TmuxSession

  afterEach(async () => {
    if (session) await session.stop()
  })

  test('shift+up/down scrolls tall preview content', async () => {
    server.reset([
      toolUseResponse([
        {
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which layout should we use?',
                header: 'Layout',
                options: [
                  {
                    label: 'Tall',
                    description: 'A preview taller than the window.',
                    preview: Array.from({ length: TOTAL_ROWS }, (_, i) =>
                      row(i + 1),
                    ).join('\n'),
                  },
                  {
                    label: 'Short',
                    description: 'A compact preview.',
                    preview: 'Only one line',
                  },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ]),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 90,
      additionalEnv: {
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
      },
    })
    await session.start()

    await session.sendLine('Show the tall preview dialog')
    await session.waitForText('press n to add notes', 30_000)

    // The scroll indicator reports the visible window instead of hiding lines.
    let screen = await session.capturePane()
    expect(screen).toContain(`of ${TOTAL_ROWS}`)
    expect(screen).not.toContain('lines hidden')
    expect(screen).toContain(row(1))
    expect(screen).not.toContain(row(TOTAL_ROWS))

    // Scroll down a few lines: the top rows leave the window.
    for (let i = 0; i < 5; i++) await session.sendSpecialKey('S-Down')
    await sleep(300)
    screen = await session.capturePane()
    expect(screen).not.toContain(row(1))
    expect(screen).toContain(row(6))
    // Option focus must not move while scrolling.
    expect(screen).toMatch(/\u276f\s*1\.\s*Tall/)

    // Scrolling past the end clamps at the last line.
    for (let i = 0; i < TOTAL_ROWS; i++) await session.sendSpecialKey('S-Down')
    await sleep(300)
    screen = await session.capturePane()
    expect(screen).toContain(row(TOTAL_ROWS))
    expect(screen).toContain(`of ${TOTAL_ROWS}`)

    // Scrolling back up returns to the top and clamps there.
    for (let i = 0; i < TOTAL_ROWS + 5; i++)
      await session.sendSpecialKey('S-Up')
    await sleep(300)
    screen = await session.capturePane()
    expect(screen).toContain(row(1))
    expect(screen).not.toContain(row(TOTAL_ROWS))
  })

  test('switching options resets preview scroll', async () => {
    server.reset([
      toolUseResponse([
        {
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which layout should we use?',
                header: 'Layout',
                options: [
                  {
                    label: 'Tall',
                    description: 'A preview taller than the window.',
                    preview: Array.from({ length: TOTAL_ROWS }, (_, i) =>
                      row(i + 1),
                    ).join('\n'),
                  },
                  {
                    label: 'Also tall',
                    description: 'Another preview taller than the window.',
                    preview: Array.from({ length: TOTAL_ROWS }, (_, i) =>
                      row(i + 1),
                    ).join('\n'),
                  },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ]),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 90,
      additionalEnv: {
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
      },
    })
    await session.start()

    await session.sendLine('Show the tall preview dialog')
    await session.waitForText('press n to add notes', 30_000)

    for (let i = 0; i < 5; i++) await session.sendSpecialKey('S-Down')
    await sleep(300)
    expect(await session.capturePane()).not.toContain(row(1))

    await session.sendSpecialKey('Down')
    await sleep(300)
    const screen = await session.capturePane()
    expect(screen).toContain(row(1))
    expect(screen).toMatch(/\u276f\s*2\.\s*Also tall/)
  })

  test('clicking the preview focuses it so bare arrows scroll', async () => {
    server.reset([
      toolUseResponse([
        {
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which layout should we use?',
                header: 'Layout',
                options: [
                  {
                    label: 'Tall',
                    description: 'A preview taller than the window.',
                    preview: Array.from({ length: TOTAL_ROWS }, (_, i) =>
                      row(i + 1),
                    ).join('\n'),
                  },
                  {
                    label: 'Short',
                    description: 'A compact preview.',
                    preview: 'Only one line',
                  },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ]),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 90,
      additionalEnv: {
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
      },
    })
    await session.start()

    await session.sendLine('Show the tall preview dialog')
    await session.waitForText('press n to add notes', 30_000)

    // Unfocused: the hint advertises the click, and bare Down moves the option
    // pointer rather than scrolling.
    let screen = await session.capturePane()
    expect(screen).toContain('click to scroll')

    // Click inside the preview box, on the row rendering its first line.
    const lines = screen.split('\n')
    const previewRowIdx = lines.findIndex(l => l.includes(row(1)))
    expect(previewRowIdx).toBeGreaterThanOrEqual(0)
    const previewCol = lines[previewRowIdx]!.indexOf(row(1))
    // +1 converts 0-indexed capture coords to the 1-indexed SGR wire format.
    await session.sendMouseClick(previewCol + 1, previewRowIdx + 1)
    await sleep(300)

    screen = await session.capturePane()
    expect(screen).toContain('to scroll')
    // The option pointer clears while the preview owns the arrows.
    expect(screen).not.toMatch(/\u276f\s*1\.\s*Tall/)

    // Bare Down now scrolls the preview and leaves option focus alone.
    for (let i = 0; i < 5; i++) await session.sendSpecialKey('Down')
    await sleep(300)
    screen = await session.capturePane()
    expect(screen).not.toContain(row(1))
    expect(screen).toContain(row(6))
    expect(screen).toContain('2. Short')

    // A digit acts on the option list, which takes focus back from the preview.
    // (Escape is not a way out: CancelRequestHandler claims it via the
    // keybinding emitter, which runs before DOM handlers, so it cancels.)
    await session.sendText('2')
    await sleep(300)
    screen = await session.capturePane()
    expect(screen).toContain('press n to add notes')
    expect(screen).toMatch(/\u276f\s*2\.\s*Short/)
  })
})
