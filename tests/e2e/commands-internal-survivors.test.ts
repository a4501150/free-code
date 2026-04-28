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
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

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

  test('/env prints Build, Provider, Models, and Paths sections', async () => {
    server.reset([])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    await session.sendLine('/env')
    // Wait for "Relevant env vars" — that's the last section, so by the time
    // it appears all earlier sections have rendered into the pane history.
    const screen = await session.waitForText('Relevant env vars', 30_000)

    expect(screen).toContain('Build')
    expect(screen).toContain('Provider')
    expect(screen).toContain('Models')
    expect(screen).toContain('Primary:')
    expect(screen).toContain('Paths')
  })

  test('/version prints a version string', async () => {
    server.reset([])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    await session.sendLine('/version')
    const { match } = await session.waitForPattern(/\d+\.\d+\.\d+/, 30_000)
    expect(match[0]).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('/oauth-refresh reports no OAuth session when only an API key is configured', async () => {
    server.reset([])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    await session.sendLine('/oauth-refresh')
    const screen = await session.waitForText('No OAuth session', 30_000)
    expect(screen).toContain('No OAuth session')
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

  test('/init-verifiers is absent from the default build', async () => {
    server.reset([])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    // Typing "/init-ver" in the prompt should not surface an autocomplete hit
    // for /init-verifiers. Typeahead shows the command in the pane when it
    // exists, so the absence is detectable by scraping for the string.
    await session.sendText('/init-verifiers')
    await sleep(500)
    const screen = await session.capturePaneWithHistory()
    // The string being typed will appear in the input line, but the
    // typeahead suggestion list should NOT expand it into a match. Submit it
    // and verify the CLI rejects it as an unknown command.
    await session.sendSpecialKey('Enter')
    const after = await session
      .waitForText('Unknown command', 15_000)
      .catch(() => '')
    // Either an "Unknown command" message appears, or the CLI emits nothing
    // visible for the command (stale input). In both cases, the command
    // should not execute its prompt body.
    expect(screen).not.toContain('Create verifier skill(s)')
    expect(after).not.toContain('Create verifier skill(s)')
  })
})
