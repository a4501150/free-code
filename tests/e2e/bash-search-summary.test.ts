/**
 * Collapsed-group summary E2E.
 *
 * Drives the real UI with mock provider turns that issue Bash calls, and
 * pins the collapsed summary line: a search pipeline with a trailing output
 * filter (`grep foo f | head`) and a compound search joined with a neutral
 * echo must count as searches, while a plain command lands in the bash
 * bucket. Guards the rendering end of isSearchOrReadBashCommand + the
 * builder's bucketing — unit tests cover the classifier alone.
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
setDefaultTimeout(120_000)
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('bash collapsed summary E2E', () => {
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

  test('search pipelines collapse as searches, plain commands as bash', async () => {
    server.reset([
      // Turn 1: materialize a searchable file (plain bash action).
      toolUseResponse([
        {
          name: 'Bash',
          input: { command: 'echo e2e_marker > s.txt', description: 'seed' },
        },
      ]),
      // Turn 2: two search-classified commands (one with a trailing output
      // filter, one compound with a neutral echo) plus one plain command.
      toolUseResponse([
        {
          name: 'Bash',
          input: {
            command: 'grep -n e2e_marker s.txt | head -20',
            description: 'filtered search',
          },
        },
        {
          name: 'Bash',
          input: {
            command:
              'grep -c e2e_marker s.txt | head -5; echo ===; grep -l e2e_marker s.txt',
            description: 'compound search',
          },
        },
        {
          name: 'Bash',
          input: { command: 'pwd', description: 'plain command' },
        },
      ]),
      textResponse('SUMMARY_DONE'),
    ])

    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    await session.submitAndApprove('seed a file then run three commands')
    let screen: string
    try {
      screen = await session.waitForText('SUMMARY_DONE', 20_000)
    } catch (e) {
      console.log('FAILED SCREEN:\n' + (await session.capturePaneWithHistory()))
      throw e
    }

    // One collapsed line: the two search pipelines count as searches; only
    // the seed echo and the plain pwd land in the bash bucket (2), not 4.
    expect(screen).toContain('Searched for 2 patterns')
    expect(screen).toContain('ran 2 bash commands')
    expect(screen).not.toContain('ran 3 bash commands')
    expect(screen).not.toContain('ran 4 bash commands')
    expect(screen).not.toContain('Read 1 file')
  })
})
