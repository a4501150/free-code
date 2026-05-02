/**
 * E2E coverage for the re-implemented "internal only" survivors:
 * /env, /version, /summary, /oauth-refresh, /debug-tool-call.
 *
 * Also asserts that the feature-gated /init-verifiers command is absent from
 * the default build (VERIFY_PLAN is an orphan feature flag — not in
 * defaultFeatures or fullExperimentalFeatures, so the default ./cli binary
 * ships without it).
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
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

setDefaultTimeout(120_000)

describe('Internal-command survivors', () => {
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

  test('stateless internal survivor commands render expected output', async () => {
    server.reset([])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    await session.sendLine('/version')
    const versionScreen = await session.waitForScreen(
      screen =>
        screen.includes('❯ /version') && /\b\d+\.\d+\.\d+ \(built/.test(screen),
      {
        timeoutMs: 30_000,
        description: '/version output',
        currentPaneOnly: true,
      },
    )
    const version = versionScreen.match(/\b(\d+\.\d+\.\d+) \(built/)?.[1]
    expect(version).toMatch(/^\d+\.\d+\.\d+/)

    await session.sendLine('/oauth-refresh')
    const oauthScreen = await session.waitForScreen(
      screen => screen.includes('No OAuth session'),
      {
        timeoutMs: 30_000,
        description: '/oauth-refresh output',
        currentPaneOnly: true,
      },
    )
    expect(oauthScreen).toContain('No OAuth session')

    await session.sendText('/init-verifiers')
    const typedScreen = await session.waitForScreen(
      screen => screen.includes('/init-verifiers'),
      {
        timeoutMs: 10_000,
        description: '/init-verifiers typed into prompt',
        currentPaneOnly: true,
      },
    )
    await session.sendSpecialKey('Enter')
    const after = await session
      .waitForScreen(
        screen =>
          screen.includes('Unknown command') ||
          screen.includes('Unknown skill'),
        {
          timeoutMs: 15_000,
          description: '/init-verifiers unknown-command output',
          currentPaneOnly: true,
        },
      )
      .catch(() => '')
    expect(typedScreen).not.toContain('Create verifier skill(s)')
    expect(after).not.toContain('Create verifier skill(s)')

    await session.sendLine('/env')
    const envScreen = await session.waitForText('Relevant env vars', 30_000)
    expect(envScreen).toContain('Build')
    expect(envScreen).toContain('Provider')
    expect(envScreen).toContain('Models')
    expect(envScreen).toContain('Primary:')
    expect(envScreen).toContain('Paths')
  })

  test('/summary returns a friendly message when there is nothing in scope', async () => {
    server.reset([])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    await session.sendLine('/summary')
    const screen = await session.waitForText(
      'No messages in the current context to summarize.',
      30_000,
    )
    expect(screen).toContain('No messages in the current context to summarize.')
  })

  test('/debug-tool-call reports no tool calls when history is empty', async () => {
    server.reset([])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    await session.sendLine('/debug-tool-call')
    const screen = await session.waitForText('No tool calls recorded', 30_000)
    expect(screen).toContain('No tool calls recorded in the current session')
  })
})
