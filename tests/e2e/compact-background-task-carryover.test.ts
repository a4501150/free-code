/**
 * Post-Compact Background Task Carry-Over E2E
 *
 * Defect: after auto-compact fires mid-turn, backgrounded tasks
 * (agent/bash/monitor) were lost from both the post-compact model context
 * and the TUI. This test backgrounds a long-running shell, forces an
 * auto-compact mid-turn via a large usage report, and then asserts:
 *
 * 1. TUI: the footer pill still counts the running shell and the /tasks
 *    dialog still lists it.
 * 2. Model: the first post-compact request body re-announces the still
 *    running background shell (the original spawn tool_result was
 *    compacted away, so without a re-announce the model has no idea the
 *    task exists).
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import type { RequestLogEntry } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { waitForRequest } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

function userTextBlob(req: RequestLogEntry): string {
  const messages = (req.body.messages ?? []) as Array<{
    role: string
    content: unknown
  }>
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      out.push(m.content)
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (typeof block.text === 'string') out.push(block.text)
      if (typeof block.content === 'string') out.push(block.content)
      if (Array.isArray(block.content)) {
        for (const inner of block.content as Array<Record<string, unknown>>) {
          if (typeof inner.text === 'string') out.push(inner.text)
        }
      }
    }
  }
  return out.join('\n\n')
}

describe('Post-compact background task carry-over', () => {
  const { server, startSession } = setupE2ESuite()

  let session: TmuxSession

  test('auto-compact mid-turn keeps backgrounded shell in TUI and re-announces it to the model', async () => {
    // Turn 1 request 1: model backgrounds a long-running shell. The padded
    // usage pushes tokenCountWithEstimation over the (lowered) auto-compact
    // threshold, so the SECOND loop iteration of the same user turn runs
    // the compaction.
    const turn1 = toolUseResponse([
      {
        name: 'Bash',
        input: {
          command: 'sleep 120',
          description: 'compact-carryover-probe',
          run_in_background: true,
        },
      },
    ])
    turn1.response.usage = {
      input_tokens: 30_000,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }

    server.reset([
      turn1,
      // Consumed by the compaction summary request (forked agent).
      textResponse('Summary: the user asked to background a long sleep.'),
      // Post-compact continuation of the same user turn.
      textResponse('Done after compact.'),
    ])

    session = await startSession({
      settings: {
        backgroundTasksEnabled: true,
        // Lower the auto-compact trigger to min(10% of window, window-0)
        // so the padded usage crosses it.
        autoCompactPercentage: 10,
        autoCompactBuffer: 0,
      },
    })

    await session.submitAndApprove(
      'Background this long-running command: sleep 120',
    )

    // The turn must complete — this only happens if the mid-turn
    // compaction succeeded and the loop continued with the post-compact
    // context.
    await session.waitForText('Done after compact.', 60_000)

    // TUI: the footer pill still counts the running background shell.
    await session.waitForText('1 shell', 10_000)

    // TUI: the /tasks dialog still lists it (auto-skips to the shell
    // detail view because exactly one task is running).
    await session.sendLine('/tasks')
    await session.waitForText('Shell details', 10_000)
    await session.sendSpecialKey('Escape')

    // Model: the first post-compact request re-announces the still
    // running background shell — the spawn tool_result was compacted away,
    // so this system-reminder is the only record the post-compact model
    // has of the task.
    const postCompact = await waitForRequest(
      server,
      req =>
        userTextBlob(req).includes('Done after compact.') === false &&
        /sleep 120/.test(userTextBlob(req)) &&
        /still running/i.test(userTextBlob(req)),
      {
        timeoutMs: 10_000,
        description: 'post-compact request re-announcing the background shell',
        onTimeout: () => {
          const log = server.getRequestLog()
          const last = log.at(-1)
          return `Last request body user text:\n${last ? userTextBlob(last).slice(0, 4000) : '(none)'}`
        },
      },
    )
    expect(postCompact).toBeDefined()
  })
})
