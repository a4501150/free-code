import { describe, expect, test } from 'bun:test'
import { formatListAgentsResult } from '../../src/tools/ListAgentsTool/ListAgentsTool.js'

describe('ListAgentsTool formatting', () => {
  test('renders agent rows addressed by name when one is registered', () => {
    const text = formatListAgentsResult({
      agents: [
        {
          id: 'a1b2c3d4',
          name: 'scout',
          description: 'map the repo',
          status: 'running',
        },
        { id: 'e5f6a7b8', description: 'fix the bug', status: 'completed' },
      ],
      sessions: [],
    })
    expect(text).toContain(
      'agent a1b2c3d4 "scout" [running] — map the repo — SendMessage to:"scout"',
    )
    expect(text).toContain(
      'agent e5f6a7b8 [completed] — fix the bug — SendMessage to:"e5f6a7b8"',
    )
  })

  test('renders session rows with the session: addressing form', () => {
    const text = formatListAgentsResult({
      agents: [],
      sessions: [
        {
          session_id: 'sess-1',
          session_kind: 'daemon-worker',
          pid: 4242,
          cwd: '/tmp',
          name: 'assistant',
        },
      ],
    })
    expect(text).toContain(
      'session sess-1 (daemon-worker, pid 4242) "assistant" — SendMessage to:"session:sess-1"',
    )
  })

  test('empty result tells the model there are no peers yet', () => {
    expect(formatListAgentsResult({ agents: [], sessions: [] })).toBe(
      'No messaging peers yet.',
    )
  })
})
