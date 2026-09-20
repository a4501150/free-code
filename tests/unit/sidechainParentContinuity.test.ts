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

// Persist-all: skill_listing now reaches the sidechain JSONL, so it is a
// valid startingParentUuid. getLastLoggedMessageUuid computes from the same
// isLoggableMessage filter that writes the file, so a hint it hands out always
// points at a row that actually persisted (the on-disk chain would truncate
// at a phantom parent otherwise).
const skillSeed = msg('skills-1', {
  type: 'attachment',
  attachment: { type: 'skill_listing', isInitial: true, skills: [] },
})

const progressTick = msg('progress-1', { type: 'progress' })

describe('getLastLoggedMessageUuid', () => {
  test('returns the raw tail: every turn-0 seed now persists', () => {
    // Exactly the runAgent turn-0 seed order: instructions, tools, skills.
    expect(
      getLastLoggedMessageUuid([
        prompt,
        instructionsSeed,
        toolsSeed,
        skillSeed,
      ]),
    ).toBe('skills-1')
  })

  test('skips progress ticks, which stay dropped for volume', () => {
    expect(
      getLastLoggedMessageUuid([prompt, instructionsSeed, toolsSeed]),
    ).toBe('tools-1')
    expect(
      getLastLoggedMessageUuid([
        prompt,
        instructionsSeed,
        skillSeed,
        progressTick,
      ]),
    ).toBe('skills-1')
    expect(getLastLoggedMessageUuid([prompt])).toBe('prompt-1')
  })

  test('null for an empty or fully-filtered batch', () => {
    expect(getLastLoggedMessageUuid([])).toBeNull()
    expect(getLastLoggedMessageUuid([progressTick])).toBeNull()
  })
})
