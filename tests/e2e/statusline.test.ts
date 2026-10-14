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
  afterEach,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(120_000)

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoggingTest, setupE2ESuite } from './tmux-helpers'
import { waitFor } from '../helpers/wait-helpers'

const test = createLoggingTest(bunTest)

describe('Statusline payload', () => {
  const { server, startSession } = setupE2ESuite()
  let cwd: string | null = null

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

    const session = await startSession({
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
    await session.sendLine('Hello')
    await session.waitForText('Hi', 20_000)
    // Hook invocation is debounced ~300ms and can fire several times as the
    // turn's usage lands — poll until the payload actually carries the
    // per-turn breakdown instead of sleeping past the debounce.
    const payload = await waitFor(
      async () => {
        try {
          const parsed = JSON.parse(
            await Bun.file(capturePath).text(),
          ) as Record<string, unknown>
          return 'last_usage' in parsed ? parsed : null
        } catch {
          return null
        }
      },
      value => value !== null,
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        description: 'statusline hook to capture the post-turn payload',
      },
    )

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

  test('embedded default status line renders when none is configured', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'claude-e2e-statusline-default-cwd-'))

    server.reset([
      {
        kind: 'success',
        response: {
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
        },
      },
    ])

    // The default status line suppresses the `? for shortcuts` hint, so the
    // idle marker is the token breakdown the default script prints.
    const session = await startSession({
      cwd,
      // TmuxSession defaults statusLine to off for hint stability; undefined
      // removes the key so the embedded default applies.
      settings: { statusLine: undefined },
      readyText: 'cw 0% ce',
    })
    await session.waitForText('#')
    await session.sendLine('Hello')
    await session.waitForText('Hi', 20_000)
    await session.stop()
  })
})
