/**
 * "Jump to bottom" pill E2E test.
 *
 * The pill is driven by a scrollHeight snapshot taken when the user first
 * scrolls away, and both ways back to the bottom (paging down, clicking the
 * pill) reach it through different code paths — the click deliberately keeps
 * the divider state alive, so it relies entirely on the pill's own
 * at-the-bottom check.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import { textResponse } from '../helpers/fixture-builders'
import {
  createLoggingTest,
  findTextCell,
  setupE2ESuite,
  sleep,
  type TmuxSession,
} from './tmux-helpers'

const test = createLoggingTest(bunTest)

setDefaultTimeout(300_000)

describe('Jump to bottom pill', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession

  test('paging back down to the bottom dismisses the pill', async () => {
    const TURNS = 6
    const responses = []
    for (let i = 0; i < TURNS; i++) {
      const lines = []
      for (let j = 0; j < 8; j++) {
        lines.push(`R${i} L${j}: ${'abcdefghij'.repeat(4)}`)
      }
      responses.push(textResponse(lines.join('\n')))
    }
    server.reset(responses)

    session = await startSession({
      height: 40,
      width: 120,
    })

    for (let i = 0; i < TURNS; i++) {
      await session.sendLine(`question ${i}`)
      // Wait for THIS turn's response before submitting the next.
      // waitForPrompt matches the already-idle screen before the turn
      // starts, so a rapid-fire loop would land questions in the message
      // queue; a queued submission rides the next request and two
      // questions consume one mock response — shifting the queue so R5 is
      // never sent and the transcript legitimately ends at R4.
      await session.waitForScreen(s => s.includes(`R${i} L7`), {
        timeoutMs: 30_000,
        intervalMs: 250,
        description: `response ${i} rendered`,
        currentPaneOnly: true,
      })
    }

    // Transcript is finished growing, prompt is idle — so the only renders
    // from here on are the ones the scroll itself causes.
    await sleep(500)
    await session.sendSpecialKey('PageUp')
    await session.waitForScreen(s => s.includes('Jump to bottom'), {
      timeoutMs: 15_000,
      intervalMs: 250,
      description: 'pill appears after paging up',
      currentPaneOnly: true,
    })

    await session.sendSpecialKey('PageDown')
    const screen = await session.waitForScreen(s => !s.includes('Jump to'), {
      timeoutMs: 15_000,
      intervalMs: 250,
      description: 'pill gone after paging back down to the bottom',
      currentPaneOnly: true,
    })
    // Actually at the bottom, not merely missing the pill.
    expect(screen).toContain(`R${TURNS - 1} L7`)

    // Same again, dismissed by clicking the pill instead. This path never
    // clears the divider snapshot (the divider line is meant to stay), so
    // the pill can only go away because the click pinned us to the bottom.
    await session.sendSpecialKey('PageUp')
    const withPill = await session.waitForScreen(
      s => s.includes('Jump to bottom'),
      {
        timeoutMs: 15_000,
        intervalMs: 250,
        description: 'pill appears after paging up again',
        currentPaneOnly: true,
      },
    )
    const cell = findTextCell(withPill, 'Jump to bottom')
    expect(cell).not.toBeNull()
    await session.sendMouseClick(cell!.col, cell!.row)
    await session.waitForScreen(s => !s.includes('Jump to'), {
      timeoutMs: 15_000,
      intervalMs: 250,
      description: 'pill gone after clicking it',
      currentPaneOnly: true,
    })
  })
})
