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
})
