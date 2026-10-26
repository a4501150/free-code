import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import {
  flushSessionStorage,
  getTranscriptPath,
  recordQueueOperation,
  recordTranscript,
  resetSessionFilePointer,
  truncateSessionTranscriptInPlace,
} from '../../src/utils/sessionStorage.js'
import { regenerateSessionId } from '../../src/bootstrap/state.js'
import { createUserMessage } from '../../src/utils/messages.js'

/**
 * Assistant-mode /clear: the transcript is emptied IN PLACE — same session id,
 * same file — so the gateway's resume pointer (pinned to that id) still names
 * the live file. The write-through suite covers the non-assistant path.
 */

const created: string[] = []
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

afterAll(() => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  for (const file of created) rmSync(file, { force: true })
})

async function recordOneOperation(content: string): Promise<void> {
  await recordQueueOperation({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: new Date().toISOString(),
    sessionId: '00000000-0000-4000-8000-000000000000',
    content,
  })
  await flushSessionStorage()
}

describe('truncateSessionTranscriptInPlace', () => {
  test('empties the file in place and keeps later appends working', async () => {
    // Start from a clean pointer so the write targets THIS session's file
    // (the Project singleton is shared across test files in one process).
    await resetSessionFilePointer()
    regenerateSessionId()
    const path = getTranscriptPath()
    await recordOneOperation('pre-clear entry')
    expect(existsSync(path)).toBe(true)
    created.push(path)

    await truncateSessionTranscriptInPlace()

    // Same path, same session id, zero bytes — the resume pointer stays valid.
    expect(getTranscriptPath()).toBe(path)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('')

    // Bookkeeping reset: a post-truncate write appends to the emptied file,
    // and nothing from before the truncation resurfaces.
    await recordOneOperation('post-clear entry')
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('post-clear entry')
    expect(content).not.toContain('pre-clear entry')
  })

  test('an append in flight at truncation time does not leak past it', async () => {
    await resetSessionFilePointer()
    regenerateSessionId()
    const path = getTranscriptPath()
    created.push(path)

    // Start a message append and DON'T await it: recordTranscript parks on
    // its dedup-set load (await getSessionMessages) before queueing the
    // write. Truncating immediately must settle that in-flight write and
    // drain it BEFORE emptying the file — pre-fix, flush() saw an empty
    // queue and idle counters, returned, and the parked append landed its
    // pre-clear entry into the freshly-truncated file.
    const recording = recordTranscript([
      createUserMessage({ content: 'in-flight pre-clear message' }),
    ])
    await truncateSessionTranscriptInPlace()
    await recording

    expect(readFileSync(path, 'utf8')).toBe('')

    // And the post-truncate path still works normally.
    await recordOneOperation('post-race entry')
    expect(readFileSync(path, 'utf8')).toContain('post-race entry')
  })

  test('a session with no file yet truncates to nothing, then materializes', async () => {
    await resetSessionFilePointer()
    regenerateSessionId()
    const path = getTranscriptPath()
    expect(existsSync(path)).toBe(false)

    // No file, no pending writes: must not throw and must not create a file.
    await truncateSessionTranscriptInPlace()
    expect(existsSync(path)).toBe(false)

    await recordOneOperation('first entry after clear')
    expect(existsSync(path)).toBe(true)
    created.push(path)
    expect(readFileSync(path, 'utf8')).toContain('first entry after clear')
  })
})
