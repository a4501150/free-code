/**
 * Clear + Scroll Blank Screen E2E Test
 *
 * Reproduces: Long conversation, scroll up to the middle,
 * scroll up/down a bit more, then type /clear → blank screen.
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
import { textResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

setDefaultTimeout(300_000)

describe('Clear after scroll blank screen', () => {
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

  test('screen is not blank after /clear when scrolled to middle of long conversation', async () => {
    // Build ~10 pages of content: 8 turns × 80 lines = 640 lines at height=40
    const responses: ReturnType<typeof textResponse>[] = []
    for (let i = 0; i < 20; i++) {
      const lines: string[] = []
      for (let j = 0; j < 80; j++) {
        lines.push(`R${i} L${j}: ${'abcdefghij'.repeat(6)}`)
      }
      responses.push(textResponse(lines.join('\n')))
    }
    server.reset(responses)

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 120,
    })
    await session.start()

    // Submit 8 prompts, wait for each turn to complete
    const TURNS = 8
    for (let i = 0; i < TURNS; i++) {
      await session.sendLine(`question ${i}`)
      await session.waitForPrompt(20_000)
    }

    // Scroll up to the middle (~8 PageUps)
    for (let i = 0; i < 8; i++) {
      await session.sendSpecialKey('PageUp')
      await sleep(150)
    }
    await sleep(500)

    // Scroll up and down a bit more (matches the repro)
    await session.sendSpecialKey('PageDown')
    await sleep(200)
    await session.sendSpecialKey('PageUp')
    await sleep(200)
    await session.sendSpecialKey('PageDown')
    await sleep(200)
    await session.sendSpecialKey('PageUp')
    await sleep(500)

    // Type /clear
    await session.sendLine('/clear')
    await sleep(3000)

    // After /clear, check screen shows the welcome logo (not blank)
    const screen = await session.capturePane()

    // Should show the prompt area
    expect(screen).toContain('for shortcuts')

    // The welcome logo must be visible after /clear
    expect(screen).toContain('Claude Code')
  })
})
