/**
 * Resume prompt-prefix-cache E2E test.
 *
 * The provider cache is a byte-identical lookup over the
 * `tools → system → messages` prefix, so a resumed session must rebuild a
 * request whose prefix is byte-compatible with the last pre-restart request.
 * Memory-only (transcript-dropped) injections leave holes mid-history and
 * truncate reuse at the first hole — this test pins the whole chain:
 *
 *   Phase 1 — two turns in one session; the second request carries the full
 *             first exchange (whatever injections fired ride in its body).
 *   Phase 2 — --continue resumes from the on-disk transcript; the first
 *             post-resume request must replay Phase 1's last request byte
 *             for byte (modulo moved cache_control breakpoints) plus a new
 *             tail, with identical tools, cached system block, and beta set.
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
import {
  MockAnthropicServer,
  type RequestLogEntry,
} from '../helpers/mock-server'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

/** cache_control breakpoints move with the end of the conversation between
 *  requests by design; the cached prefix content must not. */
function stripCacheControl(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const { cache_control: _cc, ...rest } = v as Record<string, unknown>
        return rest
      }
      return v
    }),
  )
}

function cachedSystemBlocks(system: unknown): string {
  const blocks = (system as Array<Record<string, unknown>>) ?? []
  return JSON.stringify(
    blocks.filter(b => 'cache_control' in b).map(b => b.text),
  )
}

function findRequest(
  log: RequestLogEntry[],
  marker: string,
): RequestLogEntry | undefined {
  return log.find(req =>
    JSON.stringify(req.body.messages ?? []).includes(marker),
  )
}

describe('Resume prefix cache continuity', () => {
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

  test('--continue replays the prefix byte-for-byte', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'e2e-resume-prefix-cwd-'))
    configDir = await mkdtemp(join(tmpdir(), 'e2e-resume-prefix-config-'))
    homeDir = await mkdtemp(join(tmpdir(), 'e2e-resume-prefix-home-'))

    const success = (text: string) => ({
      kind: 'success' as const,
      response: {
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 6,
          cache_read_input_tokens: 7,
        },
      },
    })

    // Phase 1 — two turns. The second request's body is the warmed prefix.
    server.reset([
      success('ALPHA-ONE response'),
      success('ALPHA-TWO response'),
    ])

    let session = new TmuxSession({
      serverUrl: server.url,
      cwd,
      reuseConfigDir: configDir,
      reuseHomeDir: homeDir,
    })
    await session.start()
    await session.submitAndWaitForResponse('prefix probe ALPHA-ONE')
    await session.submitAndWaitForResponse('prefix probe ALPHA-TWO')
    const phase1Log = server.getRequestLog()
    await session.stop()

    const lastPhase1 = findRequest(phase1Log, 'ALPHA-TWO')
    expect(lastPhase1).toBeDefined()

    // Phase 2 — resume and send a third turn.
    server.reset([success('ALPHA-THREE response')])
    session = new TmuxSession({
      serverUrl: server.url,
      cwd,
      reuseConfigDir: configDir,
      reuseHomeDir: homeDir,
      additionalArgs: ['--continue'],
    })
    await session.start()
    await session.submitAndWaitForResponse('prefix probe ALPHA-THREE')

    const phase2Log = server.getRequestLog()
    const firstPhase2 = findRequest(phase2Log, 'ALPHA-THREE')
    expect(firstPhase2).toBeDefined()

    const before = lastPhase1!
    const after = firstPhase2!

    // tools[] is frozen for the session — byte-identical across restart.
    expect(JSON.stringify(after.body.tools)).toEqual(
      JSON.stringify(before.body.tools),
    )

    // The cached system block must be byte-identical (the attribution
    // preamble before it varies per request and is not part of the cached
    // block's prefix content).
    expect(cachedSystemBlocks(after.body.system)).toEqual(
      cachedSystemBlocks(before.body.system),
    )

    // Message history: the resumed request must replay the last pre-restart
    // request's messages byte-for-byte (breakpoint aside) and only append a
    // new tail. A memory-only injection would show up as a hole here.
    const beforeMessages = stripCacheControl(
      before.body.messages ?? [],
    ) as Array<unknown>
    const afterMessages = stripCacheControl(
      after.body.messages ?? [],
    ) as Array<unknown>
    expect(afterMessages.length).toBeGreaterThan(beforeMessages.length)
    expect(afterMessages.slice(0, beforeMessages.length)).toEqual(
      beforeMessages,
    )

    // Anthropic beta header set must be identical across the restart.
    expect(after.headers['anthropic-beta'] ?? '').toEqual(
      before.headers['anthropic-beta'] ?? '',
    )

    await session.stop()
  })
})
