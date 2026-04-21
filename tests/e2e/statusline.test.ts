/**
 * Statusline payload E2E tests.
 *
 * Asserts the full payload shape delivered to the user-configured
 * `statusLine.command` hook, including the per-turn `last_usage` breakdown
 * and the cumulative `total_cache_creation_input_tokens` /
 * `total_cache_read_input_tokens` counters. These fields were added as
 * part of Step 3 of the provider-agnostic plan.
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

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Statusline payload', () => {
  let server: MockAnthropicServer
  let cwd: string | null = null

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (cwd) {
      const { rm } = await import('node:fs/promises')
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      cwd = null
    }
  })

  test('payload includes last_usage breakdown and cumulative cache counters', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'claude-e2e-statusline-cwd-'))

    // Install a statusline hook that captures the JSON payload to a file
    // so the test can read it afterwards.
    const capturePath = join(cwd, 'statusline-input.json')
    const hookPath = join(cwd, 'statusline-hook.sh')
    await writeFile(
      hookPath,
      [
        '#!/usr/bin/env bash',
        `cat > ${JSON.stringify(capturePath)}`,
        'echo "ok"',
      ].join('\n'),
      { mode: 0o755 },
    )

    // First response has non-trivial cache usage; the statusline hook should
    // see that reflected in last_usage and the cumulative totals.
    server.reset([
      {
        kind: 'success',
        response: {
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 70,
          },
        },
      },
    ])

    const session = new TmuxSession({
      serverUrl: server.url,
      cwd,
      settings: {
        statusLine: {
          type: 'command',
          command: `bash ${hookPath}`,
        },
      },
      // The configured statusLine suppresses the default `? for shortcuts`
      // hint in PromptInputFooter, so tests must wait for a different idle
      // marker. `ok` is the text our hook script echoes back to stdout,
      // which is exactly the string the CLI renders as the status line once
      // the hook finishes.
      readyText: 'ok',
    })
    await session.start()
    await session.sendLine('Hello')
    await session.waitForText('Hi', 20_000)
    // Hook invocation is debounced ~300ms; allow for scheduling + subprocess.
    const { sleep } = await import('./tmux-helpers')
    await sleep(2_000)

    // Read the captured payload.
    const raw = await Bun.file(capturePath).text()
    const payload = JSON.parse(raw) as Record<string, unknown>

    // Per-turn breakdown (populated in Step 3).
    expect(payload).toHaveProperty('last_usage')
    const lastUsage = payload.last_usage as Record<string, number>
    expect(lastUsage.input_tokens).toBe(100)
    expect(lastUsage.output_tokens).toBe(50)
    expect(lastUsage.cache_creation_input_tokens).toBe(30)
    expect(lastUsage.cache_read_input_tokens).toBe(70)

    // Cumulative counters (populated in Step 3).
    const ctxWindow = payload.context_window as Record<string, number>
    expect(ctxWindow.total_cache_creation_input_tokens).toBe(30)
    expect(ctxWindow.total_cache_read_input_tokens).toBe(70)

    await session.stop()
  })
})
