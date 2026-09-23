/**
 * E2E: prompt suggestions end-to-end. After the second turn, the forked
 * suggestion agent must reach the API (its prompt carries SUGGESTION MODE)
 * and the returned text must render as ghost text in the empty input row.
 *
 * The harness seeds promptSuggestionEnabled:false, so this test opts in —
 * without it the fork never fires in any e2e and a silent regression here
 * would go unnoticed. The queue is exactly [turn 1, turn 2, fork]: turn 1
 * is suppressed pre-API as early_conversation (one assistant message), so
 * the fork's request lands on slot 3 deterministically.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(180_000)

import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('prompt suggestion ghost text', () => {
  let server: MockAnthropicServer
  let session: TmuxSession | undefined

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(async () => {
    server.stop()
    if (session) await session.stop()
  })

  test('the post-turn fork renders its suggestion in the input row', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      settings: { promptSuggestionEnabled: true },
    })
    await session.start()

    server.reset([
      textResponse('FIRST ANSWER HERE'),
      textResponse('SECOND ANSWER HERE'),
      textResponse('run the tests'),
    ])

    await session.submitAndApprove('first user turn')
    await session.waitForText('FIRST ANSWER HERE', 30_000)

    await session.submitAndApprove('second user turn')
    await session.waitForText('SECOND ANSWER HERE', 30_000)

    // The suggestion fork runs after the turn settles; the pane must show
    // its text in the (empty) prompt row.
    await session.waitForText('run the tests', 30_000)

    const log = server.getRequestLog()
    const forkReq = log.find(entry =>
      JSON.stringify(entry.body.messages ?? '').includes('SUGGESTION MODE'),
    )
    expect(forkReq).toBeDefined()
  })
})
