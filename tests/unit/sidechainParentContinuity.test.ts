import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { getLastLoggedMessageUuid } from '../../src/utils/sessionStorage.js'
import type { Message } from '../../src/types/message.js'

let clock = 0

function msg(uuid: string, partial: Record<string, unknown>): Message {
  clock += 1000
  return {
    uuid: uuid as UUID,
    timestamp: new Date(clock).toISOString(),
    isSidechain: true,
    ...partial,
  } as unknown as Message
}

const prompt = msg('prompt-1', {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
})

const instructionsSeed = msg('instr-1', {
  type: 'attachment',
  attachment: {
    type: 'mcp_instructions_delta',
    addedNames: ['server-a'],
    addedBlocks: ['## server-a\ninstructions'],
    removedNames: [],
  },
})

const toolsSeed = msg('tools-1', {
  type: 'attachment',
  attachment: {
    type: 'mcp_tools_delta',
    generation: 1,
    servers: [],
    builtins: [],
    addedNames: [],
  },
})

// skill_listing is NOT on the isLoggableMessage allowlist — it never reaches
// the sidechain JSONL, so it must never be handed out as the next write's
// startingParentUuid (the on-disk chain would truncate at the phantom parent
// and the agent prompt + turn-0 seeds would vanish from the drill-down).
const skillSeed = msg('skills-1', {
  type: 'attachment',
  attachment: { type: 'skill_listing', isInitial: true, skills: [] },
})

describe('getLastLoggedMessageUuid', () => {
  test('skips trailing attachments the logging allowlist drops', () => {
    // Exactly the runAgent turn-0 seed order: instructions, tools, skills.
    expect(
      getLastLoggedMessageUuid([
        prompt,
        instructionsSeed,
        toolsSeed,
        skillSeed,
      ]),
    ).toBe('tools-1')
  })

  test('returns the raw tail when it persists', () => {
    expect(
      getLastLoggedMessageUuid([prompt, instructionsSeed, toolsSeed]),
    ).toBe('tools-1')
    expect(getLastLoggedMessageUuid([prompt])).toBe('prompt-1')
  })

  test('null for an empty or fully-filtered batch', () => {
    expect(getLastLoggedMessageUuid([])).toBeNull()
    expect(getLastLoggedMessageUuid([skillSeed])).toBeNull()
  })
})
