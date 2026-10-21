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

  test('renders a subagent parent row with the parent: addressing form', () => {
    const text = formatListAgentsResult({
      parent: {
        id: 'aparent000000001',
        name: 'lead',
        description: 'coordinate the build',
        status: 'running',
      },
      agents: [],
      sessions: [],
    })
    expect(text).toContain(
      'parent aparent000000001 "lead" [running] — coordinate the build — SendMessage to:"parent"',
    )
  })

  test('renders the main session as the depth-1 parent', () => {
    const text = formatListAgentsResult({
      parent: 'main-session',
      agents: [],
      sessions: [],
    })
    expect(text).toContain('parent (main session) — SendMessage to:"parent"')
    // A parent row alone means peers exist — never the empty message.
    expect(text).not.toContain('No messaging peers yet')
  })
})
