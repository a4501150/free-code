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
    // The panel outgrows a short pane once the bundled agent-browser
    // server's MCP section is listed — the header, the grid and the early
    // sections scroll out of the pane AND the alternate-screen scrollback.
    // So assert the panel's tail instead: the last section row, indented
    // to the `⎿` output-block column (5) like every classic block row —
    // not bare text at the transcript margin.
    const check = await waitFor(
      () => pane.capturePaneWithHistory(),
      h => /^ {5}Skills · \/skills$/m.test(h),
      {
        description:
          'the panel tail section indented to the output-block column',
        timeoutMs: 30_000,
      },
    )
    if (OUT_DIR) {
      await writeFile(
        join(OUT_DIR, `context-${hostedTui ? 'hosted' : 'classic'}.txt`),
        check,
      )
    }
    expect(check).toMatch(/^ {5}Skills · \/skills$/m)
    // The panel's data rows ride the same indent — the block, not bare text.
    expect(check).toMatch(/^ {5}└ /m)
    await pane.stop()
    terminal = undefined
  }
})
