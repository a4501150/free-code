/**
 * E2E: subagent background-task ownership (Phase 1) + strict end_turn
 * lifecycle (Phase 2).
 *
 *  1. Subagent tool pools include BackgroundTaskStop/BackgroundTaskList;
 *     a subagent's list is ownership-scoped (own tasks in full, others as
 *     read-only hint rows carrying the owner). Asserted on the agent
 *     request's tools[] and the tool result embedded in its next request.
 *  2. Strict end_turn: an implicit end while owning running tasks produces
 *     ONE reminder round (never a silent park), after which EndTurn kills
 *     the tasks and completes the run.
 *  3. Park: an agent that answers the reminder by waiting parks, wakes on
 *     the owned task's completion notification, and ends cleanly.
 *
 * The stop tool's ownership rules (own/foreign/main) are covered by unit
 * tests (backgroundTaskToolOwnership.test.ts) — the static fixture harness
 * cannot round-trip a dynamically generated task ID back into a tool input.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import type { RequestLogEntry } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { forAgent, forMain } from '../helpers/agent-routes'
import { userTextBlob, waitForRequest } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

const PARENT_SLEEP = 'sleep 300'
const AGENT_SLEEP = 'sleep 120'
const PARK_SLEEP = 'sleep 10'
const AGENT_DESC = 'agent dev server'
const PARENT_DESC = 'parent hold server'

function agentRequests(log: RequestLogEntry[]): RequestLogEntry[] {
  return log.filter(req =>
    JSON.stringify(req.body.system ?? '').includes('agent for Claude Code'),
  )
}

describe('subagent background task ownership', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('agent pool carries the task tools; its list is ownership-scoped; implicit end with owned tasks gets a reminder round', async () => {
    server.reset([
      // Main turn 1: background a bash of its own AND spawn the probe agent
      // (foreground, so the agent's requests route via forAgent).
      forMain(
        toolUseResponse([
          {
            name: 'Bash',
            input: {
              command: PARENT_SLEEP,
              description: PARENT_DESC,
              run_in_background: true,
            },
          },
          {
            name: 'Agent',
            input: {
              description: 'ownership probe agent',
              prompt: 'Background a sleep, then list background tasks.',
            },
          },
        ]),
      ),
      // Agent iteration 1: background its own bash.
      forAgent(
        toolUseResponse([
          {
            name: 'Bash',
            input: {
              command: AGENT_SLEEP,
              description: AGENT_DESC,
              run_in_background: true,
            },
          },
        ]),
      ),
      // Agent iteration 2: list — the tool result lands in iteration 3's
      // request body, which is what the scoping assertions read.
      forAgent(toolUseResponse([{ name: 'BackgroundTaskList', input: {} }])),
      // Agent iteration 3: text-only end — implicit, so the strict loop
      // answers with the owned-tasks reminder…
      forAgent(textResponse('agent done')),
      // …and iteration 4 is the reminder round: EndTurn kills the owned
      // sleep and completes the run.
      forAgent(toolUseResponse([{ name: 'EndTurn', input: {} }])),
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

    await session.submitAndApprove('spawn the probe agent', 90_000)

    // The strict flow adds rounds after submitAndApprove returns — wait for
    // the reminder round and then the parent's receipt before asserting.
    await waitForRequest(
      server,
      req =>
        agentRequests([req]).length === 1 &&
        userTextBlob(req).includes('still owning'),
      { description: 'owned-tasks reminder round', timeoutMs: 60_000 },
    )
    await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes('interactive agent') &&
        userTextBlob(req).includes('agent done'),
      { description: 'parent receives the agent result', timeoutMs: 60_000 },
    )

    const log = server.getRequestLog()
    const agentReqs = agentRequests(log)

    // 1. The agent's requests carry the un-gated task tools and EndTurn.
    expect(agentReqs.length).toBeGreaterThan(0)
    for (const req of agentReqs) {
      const toolNames = ((req.body.tools ?? []) as Array<{ name?: string }>)
        .map(t => t.name)
        .filter(n => typeof n === 'string')
      expect(toolNames).toContain('BackgroundTaskList')
      expect(toolNames).toContain('BackgroundTaskStop')
      expect(toolNames).toContain('EndTurn')
    }

    // 2. The BackgroundTaskList result is scoped: own task in full, the
    // parent's task only as a hint row owned by the main session.
    const reqWithListResult = agentReqs.find(req =>
      userTextBlob(req).includes(AGENT_DESC),
    )
    expect(reqWithListResult).toBeDefined()
    const listBlob = userTextBlob(reqWithListResult!)
    expect(listBlob).toContain(AGENT_SLEEP)
    expect(listBlob).toContain(PARENT_DESC)
    expect(listBlob).toContain(PARENT_SLEEP)
    expect(listBlob).toContain('other_running_tasks')
    expect(listBlob).toContain('"owner":"main"')
    // A full own row would repeat the parent's description — the hint row is
    // the only place it may appear.
    expect(listBlob.match(new RegExp(PARENT_DESC, 'g'))?.length).toBe(1)

    // 3. The reminder round: after the text-only end, the next agent request
    // carries the owned-tasks reminder listing the sleep, and EndTurn ends
    // the run (the main session receives the agent's result).
    const reqWithReminder = agentReqs.find(req =>
      userTextBlob(req).includes('still owning'),
    )
    expect(reqWithReminder).toBeDefined()
    const reminderBlob = userTextBlob(reqWithReminder!)
    expect(reminderBlob).toContain(AGENT_DESC)
    expect(reminderBlob).toContain('EndTurn')
    // The parent's final request carries the agent's report.
    const mainReqs = log.filter(req =>
      JSON.stringify(req.body.system ?? '').includes('interactive agent'),
    )
    const lastMain = mainReqs.at(-1)
    expect(lastMain).toBeDefined()
    expect(userTextBlob(lastMain!)).toContain('agent done')
  })

  test('parked agent wakes on owned-task completion and ends cleanly', async () => {
    server.reset([
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'park probe agent',
              prompt:
                'Background a short sleep, wait for it to finish, then report and end.',
            },
          },
        ]),
      ),
      // Agent iteration 1: background the sleep.
      forAgent(
        toolUseResponse([
          {
            name: 'Bash',
            input: {
              command: PARK_SLEEP,
              description: 'park probe sleep',
              run_in_background: true,
            },
          },
        ]),
      ),
      // Iteration 2: text-only end — reminder round follows.
      forAgent(textResponse('waiting for it')),
      // Iteration 3 (reminder round): the model chooses to wait — another
      // text-only end parks the agent until the sleep's notification.
      forAgent(textResponse('ok, still waiting')),
      // Iteration 4 (wake round): the notification is delivered; the model
      // reports and ends.
      forAgent(
        toolUseResponse([{ name: 'EndTurn', input: {} }], 'done waiting'),
      ),
      // Main turn 2: acknowledge.
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

    await session.submitAndApprove('spawn the park probe agent', 90_000)

    // The agent parks until the 10s sleep completes — wait for the wake
    // round (identified by the delivered task notification; the parked
    // answer itself is assistant text and never lands in the user blob)
    // and the parent's receipt before asserting.
    await waitForRequest(
      server,
      req =>
        agentRequests([req]).length === 1 &&
        userTextBlob(req).includes('<task-notification>'),
      { description: 'park wake round', timeoutMs: 60_000 },
    )
    await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes('interactive agent') &&
        userTextBlob(req).includes('done waiting'),
      {
        description: 'parent receives the parked agent result',
        timeoutMs: 60_000,
      },
    )

    const log = server.getRequestLog()
    const agentReqs = agentRequests(log)

    // The wake round: the request that follows the parked text-only answer
    // carries the sleep's completion notification.
    const wakeReq = agentReqs.find(req =>
      userTextBlob(req).includes('<task-notification>'),
    )
    expect(wakeReq).toBeDefined()
    const wakeBlob = userTextBlob(wakeReq!)
    expect(wakeBlob).toContain('still owning')
    expect(wakeBlob).toContain('<task-notification>')

    // The run completed: the parent's final request carries the report.
    const mainReqs = log.filter(req =>
      JSON.stringify(req.body.system ?? '').includes('interactive agent'),
    )
    const lastMain = mainReqs.at(-1)
    expect(lastMain).toBeDefined()
    expect(userTextBlob(lastMain!)).toContain('done waiting')
  })
})
