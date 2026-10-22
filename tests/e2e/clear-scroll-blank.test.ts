/**
 * Clear + Scroll Blank Screen E2E Test
 *
 * Reproduces: Long conversation, scroll up to the middle,
 * scroll up/down a bit more, then type /clear → blank screen.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import { textResponse } from '../helpers/fixture-builders'
import {
  TmuxSession,
  sleep,
  createLoggingTest,
  setupE2ESuite,
} from './tmux-helpers'

const test = createLoggingTest(bunTest)

setDefaultTimeout(300_000)

describe('Clear after scroll blank screen', () => {
  const { server, startSession } = setupE2ESuite()

  let session: TmuxSession

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

    session = await startSession({
      height: 40,
      width: 120,
    })

    // Submit 8 prompts, wait for each turn to complete. waitForPrompt
    // matches the already-idle screen before the turn starts, so a
    // rapid-fire loop lands questions in the message queue; a queued
    // submission rides the next request and several questions consume one
    // mock response — leaving the transcript far short of the intended
    // 8 turns of content.
    const TURNS = 8
    for (let i = 0; i < TURNS; i++) {
      await session.sendLine(`question ${i}`)
      await session.waitForScreen(s => s.includes(`R${i} L79`), {
        timeoutMs: 30_000,
        intervalMs: 250,
        description: `response ${i} rendered`,
        currentPaneOnly: true,
      })
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

    // After /clear, wait for the visible pane to show the welcome logo (not blank)
    const screen = await session.waitForScreen(
      screen =>
        screen.includes('for shortcuts') && screen.includes('Claude Code'),
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        description: 'cleared welcome screen',
        currentPaneOnly: true,
      },
    )

    // Should show the prompt area
    expect(screen).toContain('for shortcuts')

    // The welcome logo must be visible after /clear
    expect(screen).toContain('Claude Code')
  })
})
