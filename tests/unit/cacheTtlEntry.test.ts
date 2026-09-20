import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getPromptCache1hEligible } from '../../src/bootstrap/state.js'
import {
  loadTranscriptFile,
  restoreSessionMetadata,
} from '../../src/utils/sessionStorage.js'

const SID = '11111111-2222-3333-4444-555555555555'

async function writeTranscript(entries: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cache-ttl-'))
  const path = join(dir, `${SID}.jsonl`)
  await writeFile(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return path
}

const userLine = {
  type: 'user',
  uuid: 'aaaaaaaa-0000-0000-0000-000000000001',
  parentUuid: null,
  sessionId: SID,
  timestamp: new Date(0).toISOString(),
  message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
}

describe('cache-ttl-1h entry', () => {
  test('decodes into the per-session map', async () => {
    const path = await writeTranscript([
      userLine,
      { type: 'cache-ttl-1h', sessionId: SID, eligible: false },
    ])
    const { cacheTtl1hs } = await loadTranscriptFile(path)
    expect(cacheTtl1hs.get(SID as never)).toBe(false)
  })

  test('absent for sessions that never latched', async () => {
    const path = await writeTranscript([userLine])
    const { cacheTtl1hs } = await loadTranscriptFile(path)
    expect(cacheTtl1hs.has(SID as never)).toBe(false)
  })

  test('restore adopts the stored decision into the latch', async () => {
    // Adopt-else-compute: a stored `false` must arm the latch even though a
    // fresh compute (e.g. limits not loaded yet) could have decided `true`.
    restoreSessionMetadata({ cacheTtl1h: false })
    expect(getPromptCache1hEligible()).toBe(false)
    restoreSessionMetadata({ cacheTtl1h: true })
    expect(getPromptCache1hEligible()).toBe(true)
  })

  test('a log without the entry leaves the latch untouched (compute path)', async () => {
    restoreSessionMetadata({ cacheTtl1h: true })
    restoreSessionMetadata({})
    expect(getPromptCache1hEligible()).toBe(true)
  })
})
