/**
 * Coordinator Worker Transcript View E2E
 *
 * Tests that user-typed messages appear in the coordinator worker's
 * transcript view when the user navigates to a running worker and types.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { waitForRequest } from '../helpers/mock-server-wait'
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

describe('Coordinator worker transcript view', () => {
  let server: MockAnthropicServer
  let session: TmuxSession

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (session) await session.stop()
  })

  test('user-typed message appears in viewed worker transcript', async () => {
    // Separate models: coordinator=main-model, worker=worker-model.
    // This lets us distinguish requests in the FIFO mock server log.
    //
    // Flow:
    // 1. Coordinator spawns async worker (Agent tool)
    // 2. Worker starts, gets Bash sleep (blocks ~30s, keeps worker alive)
    // 3. User navigates to worker view
    // 4. User types a message while worker is running (Bash is blocking)
    // 5. Verify the user message renders in the transcript
    server.reset([
      // #0: Coordinator → Agent tool (spawn worker)
      toolUseResponse(
        [
          {
            name: 'Agent',
            input: {
              prompt: 'Run a sleep command and wait',
              description: 'sleeper worker',
              subagent_type: 'worker',
              run_in_background: true,
            },
          },
        ],
        'Spawning worker.',
      ),
      // #1: Coordinator follow-up
      textResponse('Worker launched.'),
      // #2: Worker 1st turn → Bash sleep (keeps worker alive)
      toolUseResponse([
        {
          name: 'Bash',
          input: { command: 'sleep 30', description: 'long wait' },
        },
      ]),
      // #3-5: Worker follow-ups after sleep / user message
      textResponse('Sleep done.'),
      textResponse('Got follow-up.'),
      textResponse('Done.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      settings: {
        providers: {
          'test-anthropic': {
            type: 'anthropic',
            baseUrl: server.url,
            auth: {
              active: 'apiKey',
              apiKey: { key: 'test-key-e2e-integration-99' },
            },
            models: [{ id: 'main-model' }, { id: 'worker-model' }],
          },
        },
        defaultModel: 'test-anthropic:main-model',
        defaultSubagentModel: 'test-anthropic:worker-model',
      },
      additionalEnv: {
        CLAUDE_CODE_COORDINATOR_MODE: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
      },
    })
    await session.start()

    // Kick off the coordinator
    await session.sendLine('spawn a worker')
    await session.waitForText('for shortcuts', 30_000)

    // Wait for the worker to start (it uses worker-model)
    await waitForRequest(server, req => req.body.model === 'worker-model', {
      timeoutMs: 15_000,
      description: 'worker first API request',
    })
    await sleep(500)

    // Navigate to the worker view: Down → footer tasks, Down → worker row, Enter
    await session.sendSpecialKey('Down')
    await sleep(300)
    await session.sendSpecialKey('Down')
    await sleep(300)
    await session.sendSpecialKey('Enter')
    await sleep(1000)

    // Verify we're in the worker view (banner shows worker name)
    const viewScreen = await session.capturePane()
    expect(viewScreen).toContain('sleeper worker')

    // Type a message while the worker is running (Bash sleep is blocking)
    await session.sendLine('please also say goodbye')
    await sleep(1000)

    // The user message should appear in the transcript
    const afterInput = await session.capturePaneWithHistory()
    expect(afterInput).toContain('please also say goodbye')
  })

  test('switching between leader and worker isolates each transcript', async () => {
    // The drill-down swaps the message source inside a tree that never
    // unmounts (same ScrollBox, same Messages/useVirtualScroll instances), so
    // leader state used to bleed into the worker view: the welcome/logo box,
    // leader rows, and the leader's scroll offset.
    //
    // Both transcripts are grown past the 40-row pane so each has a tail the
    // other one's scroll offset would hide, and each view is scrolled up
    // before switching away.
    const filler = (tag: string) =>
      Array.from({ length: 60 }, (_, i) => `${tag} filler line ${i}`).join('\n')
    const leaderText = `LEADERTOPMARK\n${filler('leader')}\nLEADERTAILMARK`
    const workerText = `WORKERTOPMARK\n${filler('worker')}\nWORKERTAILMARK`

    // Phase 1 responses are interchangeable and carry no markers. Exact queue
    // indices are unusable here: the coordinator's post-Agent follow-up races
    // the worker's first turn (the mock server is strictly FIFO), and the
    // leader takes another turn of its own when the worker completes. The
    // queue is reset once everything is idle, after which each explicit turn
    // is the only request in flight.
    server.reset([
      toolUseResponse(
        [
          {
            name: 'Agent',
            input: {
              prompt: 'Say ack and stop',
              description: 'sleeper worker',
              subagent_type: 'worker',
              run_in_background: true,
            },
          },
        ],
        'Spawning worker.',
      ),
      ...Array.from({ length: 6 }, () => textResponse('ack')),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      settings: {
        providers: {
          'test-anthropic': {
            type: 'anthropic',
            baseUrl: server.url,
            auth: {
              active: 'apiKey',
              apiKey: { key: 'test-key-e2e-integration-99' },
            },
            models: [{ id: 'main-model' }, { id: 'worker-model' }],
          },
        },
        defaultModel: 'test-anthropic:main-model',
        defaultSubagentModel: 'test-anthropic:worker-model',
      },
      additionalEnv: {
        CLAUDE_CODE_COORDINATOR_MODE: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
      },
    })
    await session.start()

    await session.sendLine('spawn a worker')
    await waitForRequest(server, req => req.body.model === 'worker-model', {
      timeoutMs: 15_000,
      description: 'worker first API request',
    })
    await session.waitForScreen(s => s.includes('sleeper worker'), {
      timeoutMs: 15_000,
      currentPaneOnly: true,
      description: 'worker row in coordinator panel',
    })

    // Settle: no new request for ~2s, so the reset can't land mid-turn.
    let prevCount = -1
    let stableTicks = 0
    for (let i = 0; i < 40 && stableTicks < 3; i++) {
      await sleep(700)
      const count = server.getRequestCount()
      if (count === prevCount) {
        stableTicks++
      } else {
        stableTicks = 0
        prevCount = count
      }
    }
    expect(stableTicks).toBeGreaterThanOrEqual(3)

    // Phase 2: marked responses, one per explicit turn.
    server.reset([
      textResponse(leaderText),
      textResponse(workerText),
      ...Array.from({ length: 4 }, () => textResponse('spare.')),
    ])

    await session.sendLine('grow the leader transcript')
    await session.waitForScreen(s => s.includes('LEADERTAILMARK'), {
      timeoutMs: 30_000,
      currentPaneOnly: true,
      description: 'leader tail visible',
    })

    const enterWorker = async () => {
      await session.sendSpecialKey('Down')
      await sleep(300)
      await session.sendSpecialKey('Down')
      await sleep(300)
      await session.sendSpecialKey('Enter')
      await sleep(1500)
    }

    // capturePane, never capturePaneWithHistory: tmux scrollback legitimately
    // holds text from previously viewed screens, so only the current pane can
    // establish isolation.
    await enterWorker()
    const firstWorkerView = await session.waitForScreen(
      s => s.includes('sleeper worker') && !s.includes('LEADERTAILMARK'),
      {
        timeoutMs: 15_000,
        currentPaneOnly: true,
        description: 'worker view without leader tail',
      },
    )
    // The worker transcript is short here, so all of it renders — which is
    // exactly when an unhidden logo header would be visible.
    expect(firstWorkerView).not.toContain('Welcome back')
    expect(firstWorkerView).not.toContain('LEADERTOPMARK')
    expect(firstWorkerView).not.toContain('leader filler line')

    await session.sendLine('grow the worker transcript')
    const grownWorkerView = await session.waitForScreen(
      s => s.includes('WORKERTAILMARK'),
      {
        timeoutMs: 30_000,
        currentPaneOnly: true,
        description: 'worker tail visible',
      },
    )
    expect(grownWorkerView).not.toContain('LEADERTAILMARK')
    expect(grownWorkerView).not.toContain('leader filler line')

    // Scroll the worker up, then leave: the leader must land on its own tail.
    await session.sendSpecialKey('PageUp')
    await sleep(500)
    await session.sendSpecialKey('Escape')
    const backToLeader = await session.waitForScreen(
      s => s.includes('LEADERTAILMARK'),
      {
        timeoutMs: 15_000,
        currentPaneOnly: true,
        description: 'leader tail visible after leaving worker',
      },
    )
    expect(backToLeader).not.toContain('WORKERTAILMARK')
    expect(backToLeader).not.toContain('worker filler line')

    // Scroll the leader up, then re-enter. exitTeammateView cleared the task's
    // messages and diskLoaded, so this re-runs the async sidechain bootstrap.
    await session.sendSpecialKey('PageUp')
    await sleep(500)
    await enterWorker()
    const reenteredWorker = await session.waitForScreen(
      s => s.includes('WORKERTAILMARK'),
      {
        timeoutMs: 15_000,
        currentPaneOnly: true,
        description: 'worker tail visible on re-entry',
      },
    )
    expect(reenteredWorker).not.toContain('LEADERTAILMARK')
    expect(reenteredWorker).not.toContain('leader filler line')
    expect(reenteredWorker).not.toContain('Welcome back')
  })
})
