import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import {
  flushSessionStorage,
  getTranscriptPath,
  recordQueueOperation,
  resetSessionFilePointer,
} from '../../src/utils/sessionStorage.js'
import { regenerateSessionId } from '../../src/bootstrap/state.js'

/**
 * Write-through persistence: no in-memory entry buffer. A session that
 * persists no entry creates no file; the first entry creates it, before
 * any real message arrives. Queue-operation entries are the smallest
 * writable thing, so they drive these assertions.
 */

const created: string[] = []
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

afterAll(() => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  for (const file of created) rmSync(file, { force: true })
})

function freshSessionPath(): string {
  regenerateSessionId()
  return getTranscriptPath()
}

async function recordOneOperation(path: string): Promise<void> {
  const existedBefore = existsSync(path)
  await recordQueueOperation({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: new Date().toISOString(),
    sessionId: '00000000-0000-4000-8000-000000000000',
    content: 'write-through probe',
  })
  await flushSessionStorage()
  if (!existedBefore) created.push(path)
}

describe('write-through session persistence', () => {
  test('a session that records nothing creates no file', () => {
    const path = freshSessionPath()
    expect(existsSync(path)).toBe(false)
  })

  test('the first entry materializes the file without a message', async () => {
    const path = freshSessionPath()
    expect(existsSync(path)).toBe(false)
    await recordOneOperation(path)
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('"type":"queue-operation"')
    expect(content).toContain('write-through probe')
  })

  test('a pointer reset re-materializes on the next session entry', async () => {
    // Same order the /clear and /resume paths use: reset the pointer, then
    // take a new session id.
    await resetSessionFilePointer()
    const first = freshSessionPath()
    await recordOneOperation(first)
    expect(existsSync(first)).toBe(true)

    await resetSessionFilePointer()
    const second = freshSessionPath()
    expect(existsSync(second)).toBe(false)
    await recordOneOperation(second)
    expect(existsSync(second)).toBe(true)
    // The old file keeps what it had; it is not silently rewritten elsewhere.
    expect(readFileSync(first, 'utf8')).toContain('write-through probe')
  })
})
