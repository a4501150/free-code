/**
 * AskUserQuestion Preview Scroll E2E Test
 *
 * Verifies that preview content taller than the available height can be
 * scrolled with shift+up/shift+down instead of being permanently hidden.
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
})
