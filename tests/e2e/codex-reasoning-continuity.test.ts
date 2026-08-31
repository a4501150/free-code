/**
 * E2E: Codex Responses-API reasoning continuity across turns.
 *
 * Verifies the content-block side-channel round-trip:
 *   Turn 1: Codex returns a reasoning item with `encrypted_content` →
 *           the adapter stores it on the in-memory thinking block via
 *           `codexReasoningId` / `codexEncryptedContent` extra fields.
 *   Turn 2: the adapter translates the prior assistant message back to
 *           Responses-API `input[]` and MUST include a top-level
 *           `{type:"reasoning", id, encrypted_content, summary}` item
 *           echoing turn-1's values.
 *
 * Also asserts that every request body includes
 * `include: ["reasoning.encrypted_content"]` so the server will return
 * encrypted_content in responses.
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
import { MockCodexServer } from '../helpers/mock-codex-server'
import { textResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Codex reasoning continuity E2E', () => {
  let anthropicServer: MockAnthropicServer
  let codexServer: MockCodexServer
  let session: TmuxSession | undefined

  beforeAll(async () => {
    anthropicServer = new MockAnthropicServer()
    await anthropicServer.start()
    codexServer = new MockCodexServer()
    await codexServer.start()
  })

  afterAll(() => {
    anthropicServer.stop()
    codexServer.stop()
  })

  afterEach(async () => {
    if (session) await session.stop()
    session = undefined
  })

  test('turn 2 replays separate summary, raw, and encrypted reasoning state', async () => {
    const primeTurn2 = () => ({
      kind: 'reasoning_text' as const,
      reasoningId: 'rs_turn2_XYZ',
      encryptedContent: 'ENC_BLOB_TURN2',
      reasoningText: 'Turn two raw reasoning.',
      reasoningSummary: ['Turn two summary.'],
      text: 'Turn2Answer',
    })
    codexServer.reset([
      {
        kind: 'reasoning_text' as const,
        reasoningItems: [
          {
            reasoningId: 'rs_turn1_ABC',
            encryptedContent: 'ENC_BLOB_TURN1',
            reasoningText: 'Turn one raw reasoning.',
            reasoningSummary: ['Turn one summary.', 'Second summary part.'],
          },
          {
            reasoningId: 'rs_turn1_OPAQUE',
            encryptedContent: 'ENC_BLOB_OPAQUE',
            reasoningText: '',
            reasoningSummary: [],
          },
        ],
        text: 'Turn1Answer',
      },
      primeTurn2(),
      primeTurn2(),
      primeTurn2(),
      primeTurn2(),
      primeTurn2(),
    ])
    anthropicServer.reset([textResponse('fallback')])

    session = new TmuxSession({
      serverUrl: anthropicServer.url,
      settings: {
        providers: {
          'test-codex': {
            type: 'openai-responses',
            baseUrl: codexServer.url,
            auth: {
              active: 'bearer',
              bearer: { token: 'test-codex-bearer' },
            },
            models: [
              {
                id: 'gpt-5-codex',
                label: 'Codex',
                reasoningSummary: 'auto',
              },
            ],
          },
        },
      },
      additionalArgs: ['--model', 'gpt-5-codex'],
    })
    await session.start()

    await session.sendLine('First question please')
    await session.waitForText('Turn1Answer', 20_000)

    const turn1Count = codexServer.getRequestCount()

    await session.sendLine('Second follow-up question')
    await session.waitForText('Turn2Answer', 20_000)

    const requests = codexServer.getRequestLog()
    expect(requests.length).toBeGreaterThanOrEqual(turn1Count + 1)

    for (const req of requests) {
      expect(req.body.include).toContain('reasoning.encrypted_content')
      expect(req.body.reasoning).toMatchObject({ summary: 'auto' })
    }

    const turn2First = requests[turn1Count]!
    const input = (turn2First.body.input || []) as Array<
      Record<string, unknown>
    >
    const reasoningItems = input.filter(i => i.type === 'reasoning')
    expect(reasoningItems).toHaveLength(2)
    expect(reasoningItems[0]).toMatchObject({
      id: 'rs_turn1_ABC',
      encrypted_content: 'ENC_BLOB_TURN1',
      summary: [
        { type: 'summary_text', text: 'Turn one summary.' },
        { type: 'summary_text', text: 'Second summary part.' },
      ],
      content: [{ type: 'reasoning_text', text: 'Turn one raw reasoning.' }],
    })
    expect(reasoningItems[1]).toMatchObject({
      id: 'rs_turn1_OPAQUE',
      encrypted_content: 'ENC_BLOB_OPAQUE',
      summary: [],
    })
    expect(reasoningItems[1]!.content).toBeUndefined()

    const reasoningIdx = input.findIndex(i => i.type === 'reasoning')
    const turn1MsgIdx = input.findIndex(
      i => i.type === 'message' && i.role === 'assistant',
    )
    expect(reasoningIdx).toBeGreaterThan(-1)
    if (turn1MsgIdx !== -1) {
      expect(reasoningIdx).toBeLessThan(turn1MsgIdx)
    }
  })
})
