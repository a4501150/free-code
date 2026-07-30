import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { buildConversationChain } from '../../src/utils/sessionStorage.js'
import type { TranscriptMessage } from '../../src/types/logs.js'

let clock = 0

function userEntry({
  uuid,
  parentUuid,
  logicalParentUuid,
  text,
}: {
  uuid: string
  parentUuid: string | null
  logicalParentUuid?: string
  text: string
}): TranscriptMessage {
  clock += 1000
  return {
    type: 'user',
    uuid: uuid as UUID,
    parentUuid: (parentUuid ?? null) as UUID | null,
    ...(logicalParentUuid && {
      logicalParentUuid: logicalParentUuid as UUID,
    }),
    isSidechain: true,
    agentId: 'agent-1',
    timestamp: new Date(clock).toISOString(),
    message: { role: 'user', content: text },
  } as unknown as TranscriptMessage
}

/**
 * Sidechain shape after a subagent auto-compacts: recordSidechainTranscript
 * writes the boundary with parentUuid=null and stashes the real parent in
 * logicalParentUuid.
 */
function compactedSidechain(): {
  map: Map<UUID, TranscriptMessage>
  leaf: TranscriptMessage
} {
  clock = 0
  const entries = [
    userEntry({ uuid: 'm1', parentUuid: null, text: 'first' }),
    userEntry({ uuid: 'm2', parentUuid: 'm1', text: 'second' }),
    userEntry({
      uuid: 'boundary',
      parentUuid: null,
      logicalParentUuid: 'm2',
      text: 'Conversation compacted',
    }),
    userEntry({ uuid: 'summary', parentUuid: 'boundary', text: 'summary' }),
    userEntry({ uuid: 'm3', parentUuid: 'summary', text: 'after compact' }),
  ]
  const map = new Map<UUID, TranscriptMessage>(
    entries.map(e => [e.uuid, e] as const),
  )
  return { map, leaf: entries.at(-1)! }
}

describe('buildConversationChain across a compact boundary', () => {
  test('stops at the boundary by default (API context view)', () => {
    const { map, leaf } = compactedSidechain()
    expect(buildConversationChain(map, leaf).map(m => m.uuid)).toEqual([
      'boundary',
      'summary',
      'm3',
    ])
  })

  test('followCompactBoundaries walks through to the real root', () => {
    const { map, leaf } = compactedSidechain()
    expect(
      buildConversationChain(map, leaf, {
        followCompactBoundaries: true,
      }).map(m => m.uuid),
    ).toEqual(['m1', 'm2', 'boundary', 'summary', 'm3'])
  })
})
