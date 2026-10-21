/**
 * E2E: SendMessage in normal (non-coordinator) mode, both directions.
 *
 * 1. Main → named background agent: SendMessage by name queues a pending
 *    message that drains into the agent's next request (tool-round
 *    boundary). Also asserts both messaging tools are in the main pool.
 * 2. Agent → parent: a depth-1 agent messaging to:"parent" lands on the
 *    main session's notification lane and appears in the main session's
 *    next request.
 *
 * Assertions run on the mock provider's request log (routed by system
 * prompt phrase), not the tmux pane.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import type { MockResponse } from '../helpers/sse-encoder'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import {
  AGENT_SYSTEM_PHRASE,
  forAgent,
  forMain,
  MAIN_SYSTEM_PHRASE,
} from '../helpers/agent-routes'
import { userTextBlob, waitForRequest } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

const MAIN_TO_AGENT_MESSAGE = 'STATUS_CHECK_2PLUS2: reply with just the number.'
const AGENT_TO_PARENT_MESSAGE = 'AGENT_TO_PARENT_PAYLOAD: halfway done.'

describe('SendMessage in normal mode', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('main session messages a named background agent by name', async () => {
    server.reset([
      // Main turn 1: spawn a named background agent.
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'message probe agent',
              prompt: 'Run one short command, then wait for instructions.',
              name: 'probe-worker',
              run_in_background: true,
            },
          },
        ]),
      ),
      // Agent iteration 1: a short hold; the queued message drains into
      // iteration 2 after the tool result.
      forAgent(
        toolUseResponse([
          { name: 'Bash', input: { command: 'sleep 5', description: 'hold' } },
        ]),
      ),
      // Main turn 2: message the agent by name.
      forMain(
        toolUseResponse([
          {
            name: 'SendMessage',
            input: {
              to: 'probe-worker',
              message: MAIN_TO_AGENT_MESSAGE,
            },
          },
        ]),
      ),
      // Agent iteration 2: sees the drained message, finishes.
      forAgent(textResponse('4')),
      // Main turn 3: acknowledge the SendMessage result / agent completion.
      forMain(textResponse('noted.')),
    ])

    session = await startSession({
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: {
        backgroundTasksEnabled: true,
        skipDangerousModePermissionPrompt: true,
      },
    })

    await session.submitAndApprove(
      'spawn the probe worker and message it',
      90_000,
    )

    // The messaging tools are in the main pool in normal mode.
    const first = server.getRequestLog()[0]
    const toolNames = ((first.body.tools ?? []) as Array<{ name: string }>).map(
      t => t.name,
    )
    expect(toolNames).toContain('SendMessage')
    expect(toolNames).toContain('ListAgents')

    // The queued message drained into the agent's second request.
    const agentRequest = await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes(AGENT_SYSTEM_PHRASE) &&
        userTextBlob(req).includes(MAIN_TO_AGENT_MESSAGE),
      {
        timeoutMs: 60_000,
        description: 'agent request containing the SendMessage payload',
      },
    )
    expect(agentRequest).toBeDefined()
  })

  test('depth-1 agent messages its parent (the main session)', async () => {
    server.reset([
      // Main turn 1: spawn the child agent.
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'child probe agent',
              prompt: 'Send a status update to your parent, then finish.',
              run_in_background: true,
            },
          },
        ]),
      ),
      // Agent iteration 1: message the parent. The depth-1 parent is the
      // main session — the message lands on its notification lane and is
      // drained at the main session's next turn boundary.
      forAgent(
        toolUseResponse([
          {
            name: 'SendMessage',
            input: {
              to: 'parent',
              message: AGENT_TO_PARENT_MESSAGE,
            },
          },
        ]),
      ),
      // Agent iteration 2: finish.
      forAgent(textResponse('child done')),
      // Main turn 2 (drains the agent message): acknowledge.
      forMain(textResponse('acknowledged the child update.')),
      // Main turn 3: agent completion notification turn.
      forMain(textResponse('noted the completion.')),
    ])

    session = await startSession({
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: {
        backgroundTasksEnabled: true,
        skipDangerousModePermissionPrompt: true,
      },
    })

    await session.submitAndApprove('spawn the child probe agent', 90_000)

    // The parent message reached the main session's request stream.
    const mainRequest = await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes(MAIN_SYSTEM_PHRASE) &&
        userTextBlob(req).includes(AGENT_TO_PARENT_MESSAGE),
      {
        timeoutMs: 60_000,
        description: 'main-session request containing the parent payload',
      },
    )
    expect(mainRequest).toBeDefined()
  })
})
