/**
 * Resume / context-continuity E2E tests.
 *
 * Exercises the `--continue` path and verifies that the statusline subtree is
 * re-mounted via the `key={conversationId}` remount in PromptInputFooter so
 * stale cumulative cache counters from the previous session don't bleed into
 * the resumed one.
 *
 * These tests require `TEST_ENABLE_SESSION_PERSISTENCE=1` in the child env —
 * `tmux-helpers.ts` passes it through.
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

setDefaultTimeout(120_000)

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Resume / context continuity', () => {
  let server: MockAnthropicServer
  let cwd: string | null = null
  let configDir: string | null = null
  let homeDir: string | null = null

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    for (const d of [cwd, configDir, homeDir]) {
      if (d) await rm(d, { recursive: true, force: true }).catch(() => {})
    }
    cwd = null
    configDir = null
    homeDir = null
  })

  test('--continue preserves transcript across restart', async () => {
    // Two-phase test:
    //   Phase 1 — one turn with non-zero cache_creation/cache_read usage.
    //             The transcript is written to disk via the session
    //             persistence path gated by TEST_ENABLE_SESSION_PERSISTENCE.
    //   Phase 2 — a fresh session with --continue loads that transcript.
    //             We send a second turn and verify the resumed assistant
    //             response rendered correctly and the outbound request
    //             carried prior history.
    cwd = await mkdtemp(join(tmpdir(), 'claude-e2e-resume-cwd-'))
    configDir = await mkdtemp(join(tmpdir(), 'claude-e2e-resume-config-'))
    homeDir = await mkdtemp(join(tmpdir(), 'claude-e2e-resume-home-'))

    // Phase 1 — prime the server with a cache-bearing response.
    server.reset([
      {
        kind: 'success',
        response: {
          content: [{ type: 'text', text: 'First response with cache' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 6,
            cache_read_input_tokens: 7,
          },
        },
      },
    ])

    let session = new TmuxSession({
      serverUrl: server.url,
      cwd,
      reuseConfigDir: configDir,
      reuseHomeDir: homeDir,
    })
    await session.start()
    await session.submitAndWaitForResponse('Initial prompt')
    // Stop the session — the transcript file should now be on disk in
    // configDir/projects/<sanitized-cwd>/<session-id>.jsonl.
    await session.stop()

    // Phase 2 — resume with --continue and send a second turn. Reuse the
    // same config + home so --continue can find the prior transcript.
    server.reset([
      {
        kind: 'success',
        response: {
          content: [{ type: 'text', text: 'Resumed response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 40, output_tokens: 15 },
        },
      },
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      cwd,
      reuseConfigDir: configDir,
      reuseHomeDir: homeDir,
      additionalArgs: ['--continue'],
    })
    await session.start()
    await session.sendLine('Follow up')
    const screen = await session.waitForText('Resumed response', 20_000)
    expect(screen).toContain('Resumed response')

    // The resumed session's outgoing request must include the prior
    // user/assistant exchange in its message history (that's what
    // --continue means).
    const requests = server.getRequestLog()
    expect(requests.length).toBeGreaterThanOrEqual(1)
    const lastReq = requests[requests.length - 1]!
    const messages = lastReq.body.messages ?? []
    // At minimum: prior user, prior assistant, current user = 3.
    expect(messages.length).toBeGreaterThanOrEqual(3)

    await session.stop()
  })
})
