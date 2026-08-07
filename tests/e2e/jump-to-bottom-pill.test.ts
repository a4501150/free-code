/**
 * "Jump to bottom" pill E2E test.
 *
 * The pill is driven by a scrollHeight snapshot taken when the user first
 * scrolls away, and both ways back to the bottom (paging down, clicking the
 * pill) reach it through different code paths — the click deliberately keeps
 * the divider state alive, so it relies entirely on the pill's own
 * at-the-bottom check.
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
import {
  TmuxSession,
  sleep,
  createLoggingTest,
  findTextCell,
} from './tmux-helpers'

const test = createLoggingTest(bunTest)

setDefaultTimeout(300_000)

describe('Jump to bottom pill', () => {
  let server: MockAnthropicServer
  let session: TmuxSession

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })
  afterAll(() => server.stop())
  afterEach(async () => {
    if (session) await session.stop()
  })

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

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 120,
    })
    await session.start()

    for (let i = 0; i < TURNS; i++) {
      await session.sendLine(`question ${i}`)
      await session.waitForPrompt(30_000)
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
