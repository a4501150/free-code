/**
 * E2E: Escape in a running subagent's transcript view interrupts ONLY the
 * agent's in-flight tool — the run survives (parks awaiting steering), the
 * parent is never notified of a kill, and a message typed into the view
 * steers the SAME run's next round.
 *
 * Before the fix, that Escape aborted the agent's whole run: the in-flight
 * tool was rejected, the run died, its owned background tasks were killed
 * by runAgent's finally block, and a <status>killed</status> notification
 * woke the parent, which burned a turn on recovery. The steering text
 * asserting alongside the interrupt marker in ONE agent request is the
 * run-survival signal: a killed-and-resumed agent would serve the marker
 * from its reloaded transcript too, but only after the parent was notified
 * first — 'was stopped' must never appear in any main request.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import type { RequestLogEntry } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { forAgent, forMain } from '../helpers/agent-routes'
import { userTextBlob, waitForRequest } from '../helpers/mock-server-wait'
import {
  TmuxSession,
  createLoggingTest,
  setupE2ESuite,
  sleep,
} from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

// Foreground hold: the in-flight tool the test interrupts.
const AGENT_HOLD = 'sleep 90'
// Long enough that the hold is still running when the test reaches the view.
const AGENT_PROMPT = 'Hold a foreground sleep.'
const STEER_TEXT = 'stop holding and finish now'
const AGENT_REPORT = 'steered, done'

function agentRequests(log: RequestLogEntry[]): RequestLogEntry[] {
  return log.filter(req =>
    JSON.stringify(req.body.system ?? '').includes('agent for Claude Code'),
  )
}

describe('subagent tool interrupt from the drill-down', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('Escape interrupts the in-flight tool, parks the run, steering resumes it', async () => {
    server.reset([
      // Main turn 1: background a bash of its own (keeps the footer
      // navigation shape identical to subagent-background-task-scope) and
      // spawn the probe agent in the background.
      forMain(
        toolUseResponse([
          {
            name: 'Bash',
            input: {
              command: 'sleep 300',
              description: 'parent hold server',
              run_in_background: true,
            },
          },
          {
            name: 'Agent',
            input: {
              description: 'interrupt probe agent',
              prompt: AGENT_PROMPT,
              run_in_background: true,
            },
          },
        ]),
      ),
      // Agent iteration 1: the foreground hold the test interrupts.
      forAgent(
        toolUseResponse([
          { name: 'Bash', input: { command: AGENT_HOLD, description: 'hold' } },
        ]),
      ),
      // Agent iteration 2 (post-interrupt steering round): the model obeys
      // the steering text and finishes.
      forAgent(
        toolUseResponse([{ name: 'FinishRun', input: {} }], AGENT_REPORT),
      ),
      // Main turn 1 ends; the completion notification's turn follows.
      forMain(textResponse('probe spawned, standing by')),
      forMain(textResponse('probe acknowledged')),
    ])

    session = await startSession({
      additionalArgs: ['--dangerously-skip-permissions'],
      readyText: 'bypass permissions on',
      settings: {
        backgroundTasksEnabled: true,
        skipDangerousModePermissionPrompt: true,
      },
    })

    await session.submitAndApprove('spawn the probe agent', 30_000)

    // Give the shell-task state machine a beat to register the agent's
    // hold before navigating (same cadence as the scope test).
    await sleep(1000)

    // Enter the agent's transcript view: footer task list → agent row →
    // open (same path as subagent-background-task-scope.test.ts).
    await session.sendKeys('Down')
    await session.sendKeys('Down')
    await session.sendKeys('Down')
    await session.sendKeys('Enter')
    await session.waitForText(AGENT_PROMPT, 60_000)

    // First Escape clears the retained footer selection (the prompt
    // container is not the keydown dispatch target while it is held).
    await session.sendSpecialKey('Escape')
    await sleep(500)
    // Second Escape reaches the prompt container in viewing-agent mode:
    // the agent is running and mid-round, so it interrupts the in-flight
    // hold (the run re-arms and parks) and the view stays up.
    await session.sendSpecialKey('Escape')
    await sleep(500)

    // The view stayed up (a kill would have completed the agent's task and
    // auto-exited the view).
    const pane = await session.capturePane()
    expect(pane).toContain(AGENT_PROMPT)

    // Steer the parked run from the view's composer: the message queues as
    // a pendingMessage and wakes the park.
    await session.sendLine(STEER_TEXT)

    // The parent must receive the agent's result — proving the run
    // completed normally after the interrupt.
    await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes('interactive agent') &&
        userTextBlob(req).includes(AGENT_REPORT),
      {
        description: 'parent receives the steered agent result',
        timeoutMs: 90_000,
      },
    )

    const log = server.getRequestLog()
    const agentReqs = agentRequests(log)

    // The steering round: ONE agent request carries both the steering text
    // and the interrupt marker — the same run continued past the interrupt.
    const steeredReq = agentReqs.find(req =>
      userTextBlob(req).includes(STEER_TEXT),
    )
    expect(steeredReq).toBeDefined()
    expect(userTextBlob(steeredReq!)).toContain(
      '[Request interrupted by user for tool use]',
    )

    // The regression signal: no main request ever saw a killed notification
    // for the agent.
    const mainReqs = log.filter(req =>
      JSON.stringify(req.body.system ?? '').includes('interactive agent'),
    )
    expect(mainReqs.length).toBeGreaterThan(0)
    for (const req of mainReqs) {
      expect(userTextBlob(req)).not.toContain('was stopped')
    }
  })
})
