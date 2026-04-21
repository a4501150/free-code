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

  test('turn 2 request input[] echoes turn 1 reasoning with encrypted_content', async () => {
    // Prime turn 1 once; prime several identical turn-2 responses in case
    // any transient retries happen (harmless — assertions use the first
    // turn-2 request).
    const primeTurn2 = () => ({
      kind: 'reasoning_text' as const,
      reasoningId: 'rs_turn2_XYZ',
      encryptedContent: 'ENC_BLOB_TURN2',
      reasoningText: 'Building on prior thoughts.',
      text: 'Turn2Answer',
    })
    codexServer.reset([
      {
        kind: 'reasoning_text' as const,
        reasoningId: 'rs_turn1_ABC',
        encryptedContent: 'ENC_BLOB_TURN1',
        reasoningText: 'Reasoning aloud for turn one.',
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
            models: [{ id: 'gpt-5-codex', label: 'Codex' }],
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

    // Every request must include reasoning.encrypted_content in `include`.
    for (const req of requests) {
      expect(Array.isArray(req.body.include)).toBe(true)
      expect(req.body.include).toContain('reasoning.encrypted_content')
    }

    // The first turn-2 request is at index turn1Count (0-based).
    const turn2First = requests[turn1Count]!
    const input = (turn2First.body.input || []) as Array<
      Record<string, unknown>
    >
    const reasoningItem = input.find(i => i.type === 'reasoning')
    expect(reasoningItem).toBeDefined()
    expect(reasoningItem!.id).toBe('rs_turn1_ABC')
    expect(reasoningItem!.encrypted_content).toBe('ENC_BLOB_TURN1')
    const summary = reasoningItem!.summary as Array<Record<string, unknown>>
    expect(Array.isArray(summary)).toBe(true)
    expect(summary[0]?.type).toBe('summary_text')

    // The turn 1 reasoning item must appear BEFORE any assistant
    // text-message item from turn 1 (in original block order).
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
