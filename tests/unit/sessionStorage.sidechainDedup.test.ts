import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  clearAgentSidechainUuidsCache,
  flushSessionStorage,
  getAgentTranscriptPath,
  recordSidechainTranscript,
  resetSessionFilePointer,
} from '../../src/utils/sessionStorage.js'
import { regenerateSessionId, getSessionId } from '../../src/bootstrap/state.js'
import { createUserMessage } from '../../src/utils/messages.js'
import { asAgentId } from '../../src/types/ids.js'

/**
 * recordSidechainTranscript must be idempotent per agent file: a resume
 * re-records its entire seed (the seed IS the agent's persisted
 * transcript), and before dedup every resume doubled the file with
 * identical uuids. Dedup runs against the agent's OWN uuids — never the
 * main-session set, which fork-inherited messages legitimately share.
 */

process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

const agentId = asAgentId('a0123456789abcdef')
const dirs = new Set<string>()

function agentFile(): string {
  const file = getAgentTranscriptPath(agentId)
  dirs.add(join(file, '..'))
  return file
}

function readLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

function messageEntries(lines: Array<Record<string, unknown>>) {
  return lines.filter(l => l.type === 'user' || l.type === 'assistant')
}

afterAll(async () => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
  // Unit tests share one process — hand the Project a clean pointer and
  // sidechain cache so later sessionStorage test files materialize their
  // own fresh files instead of writing into this file's stale state.
  clearAgentSidechainUuidsCache()
  await resetSessionFilePointer()
})

describe('recordSidechainTranscript dedup', () => {
  test('recording the same batch twice writes each uuid once', async () => {
    regenerateSessionId()
    const file = agentFile()
    const batch = [
      createUserMessage({ content: 'first' }),
      createUserMessage({ content: 'second' }),
      createUserMessage({ content: 'third' }),
    ]
    await recordSidechainTranscript(batch, agentId)
    await flushSessionStorage()
    const once = messageEntries(readLines(file))
    expect(once).toHaveLength(3)

    await recordSidechainTranscript(batch, agentId)
    await flushSessionStorage()
    const twice = messageEntries(readLines(file))
    expect(twice).toHaveLength(3)
    expect(new Set(twice.map(m => m.uuid)).size).toBe(3)
  })

  test('a resume-shaped re-record appends only the new tail, chained to the last persisted uuid', async () => {
    regenerateSessionId()
    const file = agentFile()
    const seed = [
      createUserMessage({ content: 'seed 1' }),
      createUserMessage({ content: 'seed 2' }),
    ]
    await recordSidechainTranscript(seed, agentId)
    await flushSessionStorage()

    const resumePrompt = createUserMessage({ content: 'resume: continue' })
    await recordSidechainTranscript([...seed, resumePrompt], agentId)
    await flushSessionStorage()

    const entries = messageEntries(readLines(file))
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map(m => m.uuid)).size).toBe(3)
    expect(entries[2]!.uuid).toBe(resumePrompt.uuid)
    // The fresh tail chains to the seed's last persisted uuid.
    expect(entries[2]!.parentUuid).toBe(seed[1]!.uuid)
  })

  test('per-message incremental recording with a parent hint is unchanged', async () => {
    regenerateSessionId()
    const file = agentFile()
    const first = createUserMessage({ content: 'm1' })
    await recordSidechainTranscript([first], agentId)
    await flushSessionStorage()

    const second = createUserMessage({ content: 'm2' })
    await recordSidechainTranscript([second], agentId, first.uuid)
    await flushSessionStorage()

    const entries = messageEntries(readLines(file))
    expect(entries).toHaveLength(2)
    expect(entries[1]!.parentUuid).toBe(first.uuid)
  })
})
