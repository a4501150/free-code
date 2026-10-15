/**
 * Pane parity for two features the hosted viewer reimplements over the
 * wire: the partial-slash palette (alias and description matches, not just
 * name prefixes) and the /context panel (the classic `⎿` output block, not
 * bare text). Each scenario runs in both the classic REPL and the hosted
 * viewer, so a wire-side regression fails the hosted leg alone.
 */
import {
  afterAll,
  beforeAll,
  expect,
  setDefaultTimeout,
  test as bunTest,
} from 'bun:test'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { textResponse } from '../helpers/fixture-builders'
import { MockAnthropicServer } from '../helpers/mock-server'
import { waitFor } from '../helpers/wait-helpers'
import { createLoggingTest, TmuxSession } from './tmux-helpers'

setDefaultTimeout(180_000)
const test = createLoggingTest(bunTest)

const OUT_DIR = process.env.PARITY_OUT_DIR

let server: MockAnthropicServer
let terminal: TmuxSession | undefined

beforeAll(async () => {
  server = new MockAnthropicServer()
  server.reset([textResponse('PARITY-OK')])
  await server.start()
  if (OUT_DIR) await mkdir(OUT_DIR, { recursive: true })
})

afterAll(() => {
  server.stop()
})

async function startMode(hostedTui: boolean): Promise<TmuxSession> {
  terminal = new TmuxSession({ serverUrl: server.url, hostedTui })
  await terminal.start()
  return terminal
}

/** Wait for `text` in the current pane; the pane lands in the failure log. */
async function expectPaneText(
  pane: TmuxSession,
  text: string,
  context: string,
): Promise<void> {
  const screen = await waitFor(
    () => pane.capturePane(),
    s => s.includes(text),
    {
      description: `${context}: "${text}" in the pane`,
      timeoutMs: 10_000,
    },
  )
  expect(screen).toContain(text)
}

test('the partial-slash palette matches aliases and descriptions in both modes', async () => {
  for (const hostedTui of [false, true]) {
    const pane = await startMode(hostedTui)
    await pane.sendText('/con')
    // Name-prefix matching alone would show /config and /context only;
    // the classic Fuse index also matches the /resume alias and the
    // description words ("continue", "conversation", "context").
    await expectPaneText(pane, '/config', 'name prefix match')
    await expectPaneText(pane, '/context', 'name prefix match')
    await expectPaneText(pane, '/resume (continue)', 'alias match')
    await expectPaneText(pane, '/clear', 'description match')
    await expectPaneText(pane, '/compact', 'description match')
    if (OUT_DIR) {
      await writeFile(
        join(OUT_DIR, `palette-${hostedTui ? 'hosted' : 'classic'}.txt`),
        await pane.capturePane(),
      )
    }
    await pane.stop()
    terminal = undefined
  }
})

test('the /context panel renders as the classic output block in both modes', async () => {
  for (const hostedTui of [false, true]) {
    const pane = await startMode(hostedTui)
    await pane.sendLine('/context')
    // The panel's header row scrolls off a short pane; the section line
    // below it is what stays visible while the panel renders.
    await pane.waitForText('System tools', 30_000)
    // Same pane shape as the REPL: the `⎿` gutter, with the panel rows
    // indented to it (5 columns) — not bare text at the transcript margin.
    // Same pane shape as the REPL: panel rows indented to the `⎿` gutter
    // column (5) — not bare text at the transcript margin. The `⎿` line
    // itself rides the block's first row, which a 40-row pane may have
    // already scrolled, so it is captured for the log, not asserted.
    const check = await waitFor(
      () => pane.capturePaneWithHistory(),
      h => /^ {5}⛶/m.test(h),
      {
        description: 'the context grid indented to the output-block column',
        timeoutMs: 10_000,
      },
    )
    if (OUT_DIR) {
      await writeFile(
        join(OUT_DIR, `context-${hostedTui ? 'hosted' : 'classic'}.txt`),
        check,
      )
    }
    expect(check).toMatch(/^ {5}⛶/m)
    await pane.stop()
    terminal = undefined
  }
})
