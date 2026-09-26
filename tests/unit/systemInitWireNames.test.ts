/**
 * The system/init stream message must carry real tool names. The Task →
 * Agent wire rename briefly shipped behind a compat translation that
 * rewrote 'Agent' back to 'Task' for structured consumers; the
 * translation is gone, so pin that 'Agent' reaches the wire and the
 * legacy name does not. The 'Task' alias on AgentTool itself stays for
 * permission rules and resumed transcripts — that's a resolution
 * concern, not an emission one.
 */
import { describe, expect, test } from 'bun:test'

import { buildSystemInitMessage } from '../../src/utils/messages/systemInit.js'

describe('system/init wire names', () => {
  test('tools array emits real tool names, not legacy compat names', () => {
    // The init message reads the API-key source, whose check throws
    // without a key — provide one for the duration of the test.
    const hadKey = 'ANTHROPIC_API_KEY' in process.env
    process.env.ANTHROPIC_API_KEY ??= 'test-key'
    try {
      const message = buildSystemInitMessage({
        tools: [{ name: 'Agent' }, { name: 'Bash' }],
        mcpClients: [],
        model: 'test-model',
        permissionMode: 'default',
        commands: [],
        agents: [],
        skills: [],
        plugins: [],
        fastMode: undefined,
      })

      const tools = (message as { tools: string[] }).tools
      expect(tools).toContain('Agent')
      expect(tools).not.toContain('Task')
      expect(tools).toContain('Bash')
    } finally {
      if (!hadKey) delete process.env.ANTHROPIC_API_KEY
    }
  })
})
