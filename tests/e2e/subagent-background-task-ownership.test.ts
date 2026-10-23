/**
 * E2E: subagent background-task ownership (Phase 1 of the ownership model).
 *
 *  1. Subagent tool pools now include BackgroundTaskStop/BackgroundTaskList
 *     (previously blanket-disallowed for every subagent) — asserted on the
 *     agent request's tools[] in the mock provider's request log.
 *  2. A subagent's BackgroundTaskList is ownership-scoped: its own task in
 *     full, other agents'/the main session's running tasks as read-only hint
 *     rows carrying the owner and a SendMessage address — asserted on the
 *     tool result embedded in the agent's next request.
 *
 * The stop tool's ownership rules (own/foreign/main) are covered by unit
 * tests (backgroundTaskToolOwnership.test.ts) — the static fixture harness
 * cannot round-trip a dynamically generated task ID back into a tool input.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import type { RequestLogEntry } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { forAgent, forMain } from '../helpers/agent-routes'
import {
  TmuxSession,
  createLoggingTest,
  setupE2ESuite,
} from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

const PARENT_SLEEP = 'sleep 300'
const AGENT_SLEEP = 'sleep 120'
const AGENT_DESC = 'agent dev server'
const PARENT_DESC = 'parent hold server'

/** Concatenate every text block of every user-role message (tool results
 *  land here) so we can grep the BackgroundTaskList output. */
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
    }
  }
  return out.join('\n\n')
}

describe('subagent background task ownership', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('agent pool carries the task tools and its list is ownership-scoped', async () => {
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
      // request body, which is what the assertions read.
      forAgent(toolUseResponse([{ name: 'BackgroundTaskList', input: {} }])),
      forAgent(textResponse('agent done')),
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

    const log = server.getRequestLog()

    // 1. The agent's requests must carry the un-gated task tools.
    const agentReqs = log.filter(req =>
      JSON.stringify(req.body.system ?? '').includes('agent for Claude Code'),
    )
    expect(agentReqs.length).toBeGreaterThan(0)
    for (const req of agentReqs) {
      const toolNames = ((req.body.tools ?? []) as Array<{ name?: string }>)
        .map(t => t.name)
        .filter(n => typeof n === 'string')
      expect(toolNames).toContain('BackgroundTaskList')
      expect(toolNames).toContain('BackgroundTaskStop')
    }

    // 2. The agent's BackgroundTaskList result is scoped: own task in full
    // (plus its spawned-agent section is empty), parent's task only as a
    // hint row owned by the main session.
    const reqWithListResult = agentReqs.find(req =>
      userTextBlob(req).includes(AGENT_DESC),
    )
    expect(reqWithListResult).toBeDefined()
    const blob = userTextBlob(reqWithListResult!)
    // Own section: the agent's bash appears with full detail.
    expect(blob).toContain(AGENT_DESC)
    expect(blob).toContain(AGENT_SLEEP)
    // Hint section: the parent's bash appears as a hint owned by main.
    expect(blob).toContain(PARENT_DESC)
    expect(blob).toContain(PARENT_SLEEP)
    expect(blob).toContain('other_running_tasks')
    expect(blob).toContain('"owner":"main"')
    // The list tool's own section must not double-list the parent's task.
    // (The hint row is the only place PARENT_DESC may appear; a full own row
    // would carry the parent's output_file path — absent from hints.)
    expect(blob.match(new RegExp(PARENT_DESC, 'g'))?.length).toBe(1)
  })
})
