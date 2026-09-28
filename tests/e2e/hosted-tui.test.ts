/**
 * The hosted default startup: a fresh interactive CLI hosts its own session
 * in an in-process sessiond and renders the wire viewer — the terminal is a
 * client of the trunk, not the session's owner screen.
 *
 * Proven here: the process publishes a sessiond attach descriptor (the
 * hosting proof — a classic REPL publishes an entrypoint:'repl' one, and
 * the hosted path skips the repl attach host), a typed prompt reaches the
 * provider through the wire, a tool permission ask opens a tray whose
 * approval runs the tool, and the reply lands in the pane.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test as bunTest,
} from 'bun:test'
import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { MockAnthropicServer } from '../helpers/mock-server'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { waitFor } from '../helpers/wait-helpers'
import { createLoggingTest, TmuxSession } from './tmux-helpers'
import type { AttachDescriptor } from '../../src/server/descriptor'

setDefaultTimeout(180_000)
const test = createLoggingTest(bunTest)

let server: MockAnthropicServer
let terminal: TmuxSession | undefined

beforeAll(async () => {
  server = new MockAnthropicServer()
  await server.start()
})

afterAll(() => {
  server.stop()
})

afterEach(async () => {
  if (terminal) {
    await terminal.stop()
    terminal = undefined
  }
})

/** Read this test's own config home: exactly one process writes descriptors. */
async function hostedDescriptor(): Promise<AttachDescriptor | undefined> {
  const dir = join(terminal!.configDirPath!, 'attach')
  if (!existsSync(dir)) return undefined
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const descriptor = JSON.parse(
        await readFile(join(dir, name), 'utf8'),
      ) as AttachDescriptor
      if (descriptor.entrypoint === 'sessiond') return descriptor
    } catch {
      // mid-write: the next poll sees it whole
    }
  }
  return undefined
}

describe('hosted TUI (default startup)', () => {
  test('the terminal hosts its session and drives it over the wire', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'touch hosted-e2e-marker' } },
      ]),
      // A slow-enough stream that the running footer can be captured
      // mid-turn, the way a real tool run gives the pane time to show it.
      textResponse('MARKER-WRITTEN-OK', { sseEventDelayMs: 1200 }),
    ])
    terminal = new TmuxSession({ serverUrl: server.url, hostedTui: true })
    await terminal.start() // waits for the idle footer, the classic marker

    // Hosting proof: this pid publishes a sessiond descriptor listing the
    // hosted session — a classic REPL run would have written an
    // entrypoint:'repl' descriptor instead, and found none here.
    const descriptor = await waitFor(
      hostedDescriptor,
      d => d !== undefined && d.sessionIds.length > 0,
      {
        description: 'the in-process sessiond attach descriptor',
        timeoutMs: 15_000,
      },
    )

    await terminal.sendLine('create the hosted marker file')
    const log = await waitForRequestCount(server, 1, {
      description: 'the viewer-submitted prompt reaching the API',
    })
    expect(JSON.stringify(log[0]!.body.messages)).toContain(
      'create the hosted marker file',
    )

    // The permission ask arrives as a wire request and renders a tray.
    await terminal.waitForText('Permission', 30_000)
    await terminal.sendSpecialKey('Enter') // "Allow" is the first option

    // Approval reached the session over the wire: the tool ran, its result
    // rides the follow-up request, and the closing reply reaches the pane.
    const followUp = await waitForRequestCount(server, 2, {
      description: 'the post-tool follow-up request',
    })
    expect(JSON.stringify(followUp[1]!.body.messages)).toContain(
      'hosted-e2e-marker',
    )

    // Mid-turn parity: while the closing reply streams, the pane carries
    // the classic running hint — not a bespoke status line.
    await terminal.waitForScreen(s => s.includes('esc to interrupt'), {
      timeoutMs: 10_000,
      intervalMs: 100,
      description: 'the classic running hint while the turn streams',
      currentPaneOnly: true,
    })

    await terminal.waitForText('MARKER-WRITTEN-OK', 30_000)
    expect(existsSync(join(terminal.cwd, 'hosted-e2e-marker'))).toBe(true)

    // After-turn parity: the turn ended, so the pane is idle again — the
    // classic hint back, and no leftover running wording (the never-idle
    // regression: the viewer used to sit on `working…` after the turn).
    const idlePane = await terminal.waitForScreen(
      s => s.includes('? for shortcuts') && !s.includes('working…'),
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        description: 'the pane back to idle wording',
        currentPaneOnly: true,
      },
    )

    // Presentation parity: the model-facing context rows ride the pane as
    // the classic collapsed disclosure row — label, real line count, and
    // the ctrl+O hint — with the reminder body folded away. (Searched in
    // history: these rows sit at the session's top, off a short screen.)
    const history = await terminal.capturePaneWithHistory()
    expect(history).toContain('System reminder · user_context_snapshot')
    const reminderRow = history
      .split('\n')
      .find(line => line.includes('System reminder · user_context_snapshot'))!
    // Real line count (pluralized like the classic row) and the expansion
    // hint for a multi-line body — the classic collapsed disclosure.
    expect(reminderRow).toMatch(/\(\d+ lines?\)/)
    const multiLineRow = history
      .split('\n')
      .find(line => /\(\d+ lines\) \(ctrl\+o to expand\)/.test(line))
    expect(multiLineRow).toBeDefined()

    // …and the bottom line carries real session numbers: the running cost.
    expect(/\$\d+\.\d{2}/.test(idlePane)).toBe(true)
    expect(idlePane).toContain('manual mode on')

    // And the hosted session id rotated nothing: the wire session is the
    // one the descriptor advertises.
    const fresh = await hostedDescriptor()
    expect(fresh?.sessionIds).toEqual(descriptor.sessionIds)
  })
})
