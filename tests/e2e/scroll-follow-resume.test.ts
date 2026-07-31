/**
 * Scroll-follow resume E2E test.
 *
 * Repro: page up mid-turn, let the transcript grow while you sit there, then
 * page back down. PageDown lands where the bottom was when you left, which
 * the new output has since pushed above the fold — and before the
 * follow-threshold fix nothing re-pinned there, so the newest message stayed
 * hidden below the fold (blank rows above the prompt) until the next submit.
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

const test = createLoggingTest(bunTest)

setDefaultTimeout(300_000)

/** Blank rows between the last transcript row and the prompt box divider. */
function bottomGap(screen: string): number {
  const rows = screen.split('\n')
  let inputRow = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/❯/.test(rows[i]!)) {
      inputRow = i
      break
    }
  }
  let dividerRow = -1
  for (let i = inputRow - 1; i >= 0; i--) {
    if (/^\s*─{20,}/.test(rows[i]!)) {
      dividerRow = i
      break
    }
  }
  let lastContent = -1
  for (let i = dividerRow - 1; i >= 0; i--) {
    if (rows[i]!.trim() !== '') {
      lastContent = i
      break
    }
  }
  return dividerRow - lastContent - 1
}

describe('Scroll follow resume', () => {
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

  test('paging back down to where you left off resumes following', async () => {
    const FILLER_TURNS = 6
    const responses = []
    for (let i = 0; i < FILLER_TURNS; i++) {
      const lines = []
      for (let j = 0; j < 8; j++) {
        lines.push(`R${i} L${j}: ${'abcdefghij'.repeat(4)}`)
      }
      responses.push(textResponse(lines.join('\n')))
    }
    // The turn the user pages away from: a slow tool call, then a tail
    // response long enough that the bottom ends up well below where it was
    // when they left (net growth even after the tool card collapses).
    const tail = Array.from({ length: 25 }, (_, i) => `TAIL L${i}`).join('\n')
    server.reset([
      ...responses,
      toolUseResponse([
        { name: 'Bash', input: { command: 'sleep 4\necho one\necho two' } },
      ]),
      textResponse(tail),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 120,
      settings: { permissions: { allow: ['Bash'] } },
    })
    await session.start()

    for (let i = 0; i < FILLER_TURNS; i++) {
      await session.sendLine(`question ${i}`)
      await session.waitForPrompt(30_000)
    }

    await session.sendLine('run the bash command')
    await sleep(1500)
    await session.sendSpecialKey('PageUp')
    // Wait out the whole turn so the transcript is finished growing — the
    // only way back to the tail is the scroll itself.
    await session.waitForPrompt(30_000)
    await sleep(500)
    const parked = await session.capturePane()
    expect(parked).not.toContain('TAIL L24')

    // Lands exactly on the bottom as it was at PageUp time.
    await session.sendSpecialKey('PageDown')

    const screen = await session.waitForScreen(s => s.includes('TAIL L24'), {
      timeoutMs: 15_000,
      intervalMs: 250,
      description: 'tail of the newest message visible after paging back down',
      currentPaneOnly: true,
    })
    expect(bottomGap(screen)).toBeLessThanOrEqual(1)
  })
})
