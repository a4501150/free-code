/**
 * E2E: the expanded task panel shows a subagent's tasks in its transcript
 * view.
 *
 * Regression for the collapse race: a subagent's TaskCreate auto-expand was
 * undone by the shared store — the update re-fetched the empty MAIN list and
 * the always-mounted collapse effect reset expandedView. The visible list
 * while an agent view is up is the agent's own, so the collapse must not
 * fire and the view must expand on entry. Pane-level assertion.
 *
 * Queue note: the backgrounded agent's request and the main's ack turn race
 * for each queue slot, so the create/update batches appear twice — whichever
 * side consumes a batch runs its own Task tools, and both sides end up with
 * a non-empty list. That's fine: the assertion targets the VIEWED AGENT's
 * panel specifically, and the main list having tasks cannot mask the bug
 * (before the fix the agent view collapsed regardless of main-list state).
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
setDefaultTimeout(180_000)

import type { MockResponse } from '../helpers/sse-encoder'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import type { QueueSelectorEntry } from '../helpers/mock-server'
import {
  AGENT_SYSTEM_PHRASE,
  forAgent,
  forMain,
  MAIN_SYSTEM_PHRASE,
} from '../helpers/agent-routes'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'

const test = createLoggingTest(bunTest)

const SUBJECT_A = 'Panel task alpha probe'
const SUBJECT_B = 'Panel task beta probe'

function createBatch() {
  return toolUseResponse([
    {
      name: 'TaskCreate',
      input: { subject: SUBJECT_A, description: 'alpha' },
    },
    {
      name: 'TaskCreate',
      input: { subject: SUBJECT_B, description: 'beta' },
    },
  ])
}

function holdOnSleep() {
  return toolUseResponse([
    { name: 'Bash', input: { command: 'sleep 15', description: 'hold' } },
  ])
}

describe('subagent task panel', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('expanded panel lists the viewed agent tasks without a manual toggle', async () => {
    // If one phrase were contained in the other, a request could match the
    // wrong side's entry and routing would silently misfire.
    expect(AGENT_SYSTEM_PHRASE.includes(MAIN_SYSTEM_PHRASE)).toBe(false)
    expect(MAIN_SYSTEM_PHRASE.includes(AGENT_SYSTEM_PHRASE)).toBe(false)

    server.reset([
      forMain(
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'panel probe agent',
              prompt: 'Create two tasks and hold.',
              run_in_background: true,
            },
          },
        ]),
      ),
      // The agent's first iteration creates both tasks; the sleep holds it
      // running while the test navigates into its transcript view. Main's
      // ack and later notification turns route separately.
      forAgent(createBatch()),
      forAgent(holdOnSleep()),
      // Strict end_turn: the agent must call EndTurn to finish.
      forAgent(
        toolUseResponse([{ name: 'EndTurn', input: {} }], 'agent holding'),
      ),
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

    await session.submitAndApprove('spawn the probe agent', 90_000)

    // Focus the footer task list and move down to the agent row (main is
    // the first row), then open the agent's transcript view.
    await session.sendKeys('Down')
    await session.sendKeys('Down')
    await session.sendKeys('Down')
    await session.sendKeys('Enter')

    // Assert on the panel's checkbox rows (glyph + subject), not the bare
    // subjects: the transcript view itself renders the agent's TaskCreate
    // tool-use lines, which mention the subjects without the panel. The
    // pre-fix pane shows only the collapsed single-task "Next: ..." line.
    await session.waitForText(SUBJECT_A, 60_000)
    const pane = await session.capturePane()
    expect(pane).toContain(`◻ ${SUBJECT_A}`)
    expect(pane).toContain(`◻ ${SUBJECT_B}`)
  })
})
