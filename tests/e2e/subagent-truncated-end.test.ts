/**
 * E2E: truncated subagent ends must not read as completions.
 *
 * A stream that dies without producing text (the live GLM failure: the
 * server closed the connection mid-generation) returns query()'s
 * 'completed' terminal exactly like a deliberate text-only end —
 * stop_reason cannot referee here. The run loop therefore judges the
 * run's tail: a text-less end gets ONE truncated-turn nudge (recovery), a
 * second consecutive one stops the run with the truthful
 * `stopped: ended_without_final_message` status instead of delivering a
 * stale mid-run text fragment as the result.
 *
 * The SSE-parser-level fix (EOF without a terminal marker is a transport
 * error) is covered by unit tests; these fixtures drive the run loop
 * directly through the mock provider, whose streams always terminate
 * cleanly.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import type { RequestLogEntry } from '../helpers/mock-server'
import {
  MockResponse,
  textResponse,
  toolUseResponse,
} from '../helpers/fixture-builders'
import { forAgent, forMain } from '../helpers/agent-routes'
import {
  agentRequests,
  userTextBlob,
  waitForRequest,
} from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

/** A reasoning-only end: the shape of a stream cut before any text. */
function reasoningOnlyResponse(thinking: string): MockResponse {
  return {
    kind: 'success',
    response: {
      content: [{ type: 'thinking', thinking, signature: 'test-sig' }],
      stop_reason: 'end_turn',
    },
  }
}

describe('subagent truncated ends', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('a text-less end gets one recovery nudge, then the report completes the run', async () => {
    server.reset([
      // Main turn 1: spawn the probe agent (foreground).
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'truncation probe agent',
              prompt: 'Do the work, then report.',
            },
          },
        ]),
      ),
      // Agent iteration 1: real tool work.
      forAgent(
        toolUseResponse([
          {
            name: 'Bash',
            input: { command: 'echo probe-work', description: 'probe work' },
          },
        ]),
      ),
      // Agent iteration 2: the round ends on a reasoning-only turn —
      // nothing the model wrote reached the caller. The run loop must
      // answer with the truncated-turn nudge, never a completion.
      forAgent(reasoningOnlyResponse('let me verify the result first')),
      // Agent iteration 3 (recovery round): the final report.
      forAgent(textResponse('probe final report')),
      // Main turn 2: acknowledge and end the turn.
      forMain(textResponse('probe finished')),
    ])

    session = await startSession({
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: {
        backgroundTasksEnabled: true,
        skipDangerousModePermissionPrompt: true,
      },
    })

    await session.submitAndApprove('spawn the truncation probe', 30_000)

    await waitForRequest(
      server,
      req =>
        agentRequests([req]).length >= 1 &&
        userTextBlob(req).includes('cut off before it delivered anything'),
      { description: 'truncated-turn nudge round', timeoutMs: 60_000 },
    )
    // The recovery round ends the run and the parent receives the report.
    await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes('interactive agent') &&
        userTextBlob(req).includes('probe final report'),
      {
        description: 'parent receives the recovered report',
        timeoutMs: 60_000,
      },
    )

    // Exactly one nudge was delivered.
    const nudges = server
      .getRequestLog()
      .filter(req => userTextBlob(req).includes('cut off before it delivered'))
    expect(nudges.length).toBe(1)
  })

  test('a second consecutive text-less end stops the run with the truthful status', async () => {
    server.reset([
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'backstop probe agent',
              prompt: 'Do the work, then report.',
            },
          },
        ]),
      ),
      // Iteration 1: truncated end — nudge round follows.
      forAgent(reasoningOnlyResponse('starting the work')),
      // Iteration 2 (recovery round): truncated again — systemic. The
      // backstop stops the run truthfully instead of completing it.
      forAgent(reasoningOnlyResponse('continuing the work')),
      // Main turn 2: acknowledge and end the turn.
      forMain(textResponse('probe finished')),
    ])

    session = await startSession({
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: {
        backgroundTasksEnabled: true,
        skipDangerousModePermissionPrompt: true,
      },
    })

    await session.submitAndApprove('spawn the backstop probe', 30_000)

    // The parent's Agent tool_result carries the truthful stopped marker —
    // the run must NOT have been reported as a plain completion.
    await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes('interactive agent') &&
        userTextBlob(req).includes('ended_without_final_message'),
      {
        description: 'parent sees the truthful stopped status',
        timeoutMs: 60_000,
      },
    )

    // Exactly one nudge preceded the backstop.
    const nudges = server
      .getRequestLog()
      .filter(req => userTextBlob(req).includes('cut off before it delivered'))
    expect(nudges.length).toBe(1)
  })
})
