/**
 * E2E: while viewing a subagent's transcript, the background tasks dialog
 * lists the viewed agent's own backgrounded work, not the parent session's.
 *
 * Markers are COMMANDS, not descriptions: the dialog's bash rows render the
 * command. The parent's `sleep 200` appears in the main transcript only —
 * which the agent view does not render (the agent's own transcript collapses
 * its tool uses into "Ran N bash commands") — so its presence on the dialog
 * pane means the scoping is broken. The agent's `sleep 201`/`sleep 202`
 * rows keep the dialog in list mode (a single row auto-skips to the shell
 * detail view). The agent's PROMPT marks view entry: it renders only in the
 * agent's transcript header, and the view auto-exits when the agent's
 * foreground hold finishes, so the dialog must open before that.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { forAgent, forMain } from '../helpers/agent-routes'
import {
  TmuxSession,
  createLoggingTest,
  sleep,
  setupE2ESuite,
} from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

const PARENT_SLEEP = 'sleep 200'
const AGENT_SLEEP_A = 'sleep 201'
const AGENT_SLEEP_B = 'sleep 202'
// Foreground hold keeping the agent running while the test exercises the
// agent view: long enough for every dialog round-trip below.
const AGENT_HOLD = 'sleep 90'
const AGENT_PROMPT = 'Background two sleeps and hold.'

describe('subagent background task scope', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession | undefined

  test('tasks dialog in agent view lists the agent’s bash, not the parent’s', async () => {
    server.reset([
      // Main turn 1: background a bash of its own AND spawn the probe agent.
      forMain(
        toolUseResponse([
          {
            name: 'Bash',
            input: {
              command: PARENT_SLEEP,
              description: 'parent-owned sleep',
              run_in_background: true,
            },
          },
          {
            name: 'Agent',
            input: {
              description: 'scope probe agent',
              prompt: AGENT_PROMPT,
              run_in_background: true,
            },
          },
        ]),
      ),
      // Agent iteration 1: two backgrounded sleeps — two rows keep the
      // dialog in list mode.
      forAgent(
        toolUseResponse([
          {
            name: 'Bash',
            input: {
              command: AGENT_SLEEP_A,
              description: 'agent-owned sleep a',
              run_in_background: true,
            },
          },
          {
            name: 'Bash',
            input: {
              command: AGENT_SLEEP_B,
              description: 'agent-owned sleep b',
              run_in_background: true,
            },
          },
        ]),
      ),
      // Agent iteration 2: a foreground hold so the agent stays running
      // while the test navigates into its transcript view.
      forAgent(
        toolUseResponse([
          { name: 'Bash', input: { command: AGENT_HOLD, description: 'hold' } },
        ]),
      ),
      forAgent(textResponse('agent holding')),
      // Main turn 2: acknowledge and end the turn.
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

    // Give both shell-task state machines a beat to register their
    // backgrounded sleeps before navigating.
    await sleep(1000)

    // Enter the agent's transcript view: focus the footer task list, move
    // down to the agent row (the parent's bash does not add a row — the
    // footer list is agent tasks only), then open. Same path as
    // subagent-task-panel.test.ts.
    await session.sendKeys('Down')
    await session.sendKeys('Down')
    await session.sendKeys('Down')
    await session.sendKeys('Enter')

    // The agent view renders the agent's transcript — its prompt line is
    // agent-side only (the main transcript shows the Agent tool use with
    // just the description, and collapses the rest).
    await session.waitForText(AGENT_PROMPT, 60_000)

    // The footer pill is scoped too: in agent view it counts the viewed
    // agent's two shells — not the parent's bash, agent row and shells
    // (which would read "4 background tasks" unscoped).
    const pillPane = await session.capturePane()
    expect(pillPane).toContain('2 shells')

    // Keyboard parity: Shift+Down opens the scoped tasks dialog from
    // inside the agent view. Entering the view clears the footer
    // selection, which keeps the prompt container as the keydown dispatch
    // target.
    await session.sendSpecialKey('S-Down')
    await session.waitForText('Background tasks', 10_000)

    let pane = await session.capturePane()
    expect(pane).toContain(AGENT_SLEEP_A)
    expect(pane).toContain(AGENT_SLEEP_B)
    // The regression signal: the parent session's backgrounded bash must
    // not be listed while the agent view is up.
    expect(pane).not.toContain(PARENT_SLEEP)

    // Escape closes the dialog.
    await session.sendSpecialKey('Escape')
    await sleep(500)
    pane = await session.capturePane()
    expect(pane).not.toContain('Background tasks')

    // Typed slash commands run as commands in agent view (parity with the
    // main session) instead of being submitted to the viewed agent as a
    // steering prompt. waitForText can't distinguish this opening from the
    // earlier one (the pane log still holds its frames), so poll the live
    // screen for the dialog.
    await session.sendLine('/tasks')
    let dialogOpen = false
    for (let i = 0; i < 20 && !dialogOpen; i++) {
      await sleep(500)
      dialogOpen = (await session.capturePane()).includes('Background tasks')
    }
    expect(dialogOpen).toBe(true)
    pane = await session.capturePane()
    expect(pane).toContain(AGENT_SLEEP_A)
    expect(pane).not.toContain(PARENT_SLEEP)
  })
})
