/**
 * E2E: subagent background-task ownership (Phase 1) + strict end_turn
 * lifecycle (Phase 2).
 *
 *  1. Subagent tool pools include BackgroundTaskStop/BackgroundTaskList;
 *     a subagent's list is ownership-scoped (own tasks in full, others as
 *     read-only hint rows carrying the owner). Asserted on the agent
 *     request's tools[] and the tool result embedded in its next request.
 *  2. Strict end_turn: an implicit end while owning running tasks produces
 *     ONE reminder round (never a silent park); the FinishRun that follows is
 *     itself gated (first strike — the tasks are still running), and only
 *     the second consecutive FinishRun kills the tasks and completes the
 *     run.
 *  3. Park: an agent that answers the reminder by waiting parks, wakes on
 *     the owned task's completion notification, and ends cleanly.
 *
 * The stop tool's ownership rules (own/foreign/main) are covered by unit
 * tests (backgroundTaskToolOwnership.test.ts) — the static fixture harness
 * cannot round-trip a dynamically generated task ID back into a tool input.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
      // …and iteration 4 is the reminder round: the FinishRun there arrives
      // with the sleep still running, so the gate returns it (first
      // strike)…
      forAgent(toolUseResponse([{ name: 'FinishRun', input: {} }])),
      // …and iteration 5 takes the gated round's second FinishRun: honored,
      // the owned sleep is killed and the run completes.
      forAgent(toolUseResponse([{ name: 'FinishRun', input: {} }])),
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

    await session.submitAndApprove('spawn the probe agent', 30_000)

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

    // 1. The agent's requests carry the un-gated task tools and FinishRun.
    expect(agentReqs.length).toBeGreaterThan(0)
    for (const req of agentReqs) {
      const toolNames = ((req.body.tools ?? []) as Array<{ name?: string }>)
        .map(t => t.name)
        .filter(n => typeof n === 'string')
      expect(toolNames).toContain('BackgroundTaskList')
      expect(toolNames).toContain('BackgroundTaskStop')
      expect(toolNames).toContain('FinishRun')
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
    // carries the owned-tasks reminder listing the sleep, the FinishRun over
    // the still-running sleep is gated with its own reminder, and the
    // second FinishRun ends the run (the main session receives the result).
    const reqWithReminder = agentReqs.find(req =>
      userTextBlob(req).includes('still owning'),
    )
    expect(reqWithReminder).toBeDefined()
    const reminderBlob = userTextBlob(reqWithReminder!)
    expect(reminderBlob).toContain(AGENT_DESC)
    expect(reminderBlob).toContain('FinishRun')
    // The gated round: the FinishRun over the still-running sleep was
    // returned with its own reminder stating the second-strike contract.
    const reqWithGate = agentReqs.find(req =>
      userTextBlob(req).includes('was not carried out'),
    )
    expect(reqWithGate).toBeDefined()
    expect(userTextBlob(reqWithGate!)).toContain('call FinishRun again')
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
        toolUseResponse([{ name: 'FinishRun', input: {} }], 'done waiting'),
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

    await session.submitAndApprove('spawn the park probe agent', 30_000)

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

  test('park-wake notification persists to the sidechain transcript', async () => {
    // Regression (round-boundary attachment drop): every attachment the
    // subagent's query() yielded — drained task notifications included —
    // was shown in the live view but never recorded and never carried
    // into the next round, so the model's own completion notifications
    // evaporated at each round boundary and the subagent's JSONL held
    // none of them.
    server.reset([
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'persist probe agent',
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
              description: 'persist probe sleep',
              run_in_background: true,
            },
          },
        ]),
      ),
      // Iteration 2: text-only end — reminder round follows.
      forAgent(textResponse('waiting for it')),
      // Iteration 3 (reminder round): another text-only end parks.
      forAgent(textResponse('ok, still waiting')),
      // Iteration 4 (wake round): notification delivered; report and end.
      forAgent(
        toolUseResponse([{ name: 'FinishRun', input: {} }], 'done waiting'),
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

    await session.submitAndApprove('spawn the persist probe agent', 30_000)
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

    // The sleep's completion notification must be IN the subagent's
    // sidechain JSONL on disk — recorded at the park wake, not merely
    // surfaced live and dropped. Scoped by this agent's unique prompt text
    // so a leftover file from another run can't satisfy the assertion.
    const configDir = session.configDirPath
    expect(configDir).not.toBeNull()
    const projectsDir = join(configDir!, 'projects')
    const agentJsonls: string[] = []
    for (const projectKey of readdirSync(projectsDir)) {
      const projectDir = join(projectsDir, projectKey)
      for (const entry of readdirSync(projectDir)) {
        const subagentsDir = join(projectDir, entry, 'subagents')
        if (!existsSync(subagentsDir)) continue
        agentJsonls.push(
          ...readdirSync(subagentsDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => join(subagentsDir, f)),
        )
      }
    }
    expect(agentJsonls.length).toBeGreaterThan(0)
    const persisted = agentJsonls.find(f => {
      const text = readFileSync(f, 'utf8')
      return (
        text.includes('persist probe sleep') &&
        text.includes('<task-notification>')
      )
    })
    expect(persisted).toBeDefined()
  })

  test('post-wake implicit end parks silently — no second owned-tasks reminder', async () => {
    // Regression: parkAndAwaitWake used to reset remindedAboutOwnedTasks on
    // every meaningful wake, so an agent that answered the first reminder
    // and kept ending text-only after each notification was re-nagged per
    // wake — the repeated "still owning" rounds pushed models back into
    // polling/no-op busy-waits. The reminder gate must fire once per run.
    server.reset([
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'double park probe agent',
              prompt:
                'Background two sleeps, wait for both to finish, then report and end.',
            },
          },
        ]),
      ),
      // Agent iteration 1: background BOTH sleeps in one response.
      forAgent(
        toolUseResponse([
          {
            name: 'Bash',
            input: {
              command: 'sleep 4',
              description: 'short park sleep',
              run_in_background: true,
            },
          },
          {
            name: 'Bash',
            input: {
              command: 'sleep 15',
              description: 'long park sleep',
              run_in_background: true,
            },
          },
        ]),
      ),
      // Iteration 2: text-only end — implicit, so the strict loop answers
      // with the (single) owned-tasks reminder…
      forAgent(textResponse('waiting for both')),
      // Iteration 3 (reminder round): choose to wait — text-only end parks.
      forAgent(textResponse('ok, parked for both')),
      // Iteration 4 (wake round 1, short sleep done): text-only end again —
      // must re-park SILENTLY (no second reminder round before the long
      // sleep's notification).
      forAgent(textResponse('short one done, still waiting for the long one')),
      // Iteration 5 (wake round 2, long sleep done): both tasks finished,
      // so the single FinishRun is honored (zero owned tasks).
      forAgent(
        toolUseResponse([{ name: 'FinishRun', input: {} }], 'both done'),
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

    await session.submitAndApprove('spawn the double park probe agent', 30_000)

    // Wait for the first wake (short sleep ~4s) and the parent's receipt
    // (after the long sleep ~15s) before asserting — notification-driven.
    await waitForRequest(
      server,
      req =>
        agentRequests([req]).length === 1 &&
        userTextBlob(req).includes('<task-notification>'),
      { description: 'first park wake round', timeoutMs: 60_000 },
    )
    await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes('interactive agent') &&
        userTextBlob(req).includes('both done'),
      {
        description: 'parent receives the parked agent result',
        timeoutMs: 60_000,
      },
    )

    const log = server.getRequestLog()
    const agentReqs = agentRequests(log)

    // Two wake rounds deliver one task-notification each.
    const wakeReqs = agentReqs.filter(req =>
      userTextBlob(req).includes('<task-notification>'),
    )
    expect(wakeReqs.length).toBe(2)

    // The reminder fired exactly ONCE per run: history accumulates user
    // messages, so the LAST agent request carries every reminder ever
    // delivered — a second "still owning" round (the old per-wake re-arm)
    // would double the count.
    const lastAgentReq = agentReqs.at(-1)
    expect(lastAgentReq).toBeDefined()
    const stillOwningCount =
      userTextBlob(lastAgentReq!).match(/still owning/g)?.length ?? 0
    expect(stillOwningCount).toBe(1)
  })

  test('text-only end with no owned tasks completes the run — no reminder, no FinishRun', async () => {
    // Implicit completion: a text-only end with the queue drained and no
    // running owned tasks COMPLETES the run, the final text being the
    // delivered result. The old strict end_turn model answered such an end
    // with an end-turn reminder (and force-completed after repeats) — the
    // reminder loop that pushed models into no-op busy-waits.
    server.reset([
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'implicit completion probe agent',
              prompt: 'Run one quick command, then report and finish.',
            },
          },
        ]),
      ),
      // Agent iteration 1: one quick foreground command.
      forAgent(
        toolUseResponse([
          {
            name: 'Bash',
            input: { command: 'echo probe', description: 'quick probe' },
          },
        ]),
      ),
      // Iteration 2 (tool-result round): text-only end — nothing running,
      // queue empty: the run completes on this turn.
      forAgent(textResponse('probe ran clean, nothing to flag')),
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

    await session.submitAndApprove('spawn the implicit probe agent', 30_000)
    await waitForRequest(
      server,
      req =>
        JSON.stringify(req.body.system ?? '').includes('interactive agent') &&
        userTextBlob(req).includes('probe ran clean'),
      {
        description: 'parent receives the implicit-end result',
        timeoutMs: 60_000,
      },
    )

    const log = server.getRequestLog()
    const agentReqs = agentRequests(log)
    // Exactly two agent rounds: the tool round and the text-only end. A
    // reminder round (old behavior) would have produced a third.
    expect(agentReqs.length).toBe(2)
    // No end-turn reminder was ever delivered.
    for (const req of agentReqs) {
      expect(userTextBlob(req)).not.toContain('end-turn-reminder')
    }
  })
})
