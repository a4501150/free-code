import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadTranscriptFile } from '../../src/utils/sessionStorage.js'
import { readTranscriptForLoad } from '../../src/utils/sessionStoragePortable.js'

const CHUNK_SIZE = 1024 * 1024
const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const ASSISTANT_ID = '33333333-3333-4333-8333-333333333333'
const SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444'

let dirsToClean: string[] = []

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'free-code-session-storage-'))
  dirsToClean.push(dir)
  const file = join(dir, 'session.jsonl')
  await writeFile(file, content)
  return file
}

async function readForLoadString(file: string): Promise<string> {
  const { size } = await stat(file)
  const result = await readTranscriptForLoad(file, size)
  return result.postBoundaryBuf.toString('utf8')
}

function transcriptMessage(
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
) {
  return JSON.stringify({
    parentUuid,
    isSidechain: false,
    type,
    message: {
      role: type,
      content: type === 'user' ? 'hello' : [{ type: 'text', text: 'hi' }],
    },
    uuid,
    timestamp:
      type === 'user' ? '2026-05-03T00:00:00.000Z' : '2026-05-03T00:00:01.000Z',
    cwd: '/repo',
    userType: 'external',
    sessionId: SESSION_ID,
    version: 'test',
  })
}

function attributionSnapshotLine(messageId = SNAPSHOT_ID): string {
  return JSON.stringify({
    type: 'attribution-snapshot',
    messageId,
    surface: 'test',
    fileStates: {
      '/repo/a.ts': {
        contentHash: 'hash',
        claudeContribution: 1,
        mtime: 1,
      },
    },
    promptCount: 1,
  })
}

afterEach(async () => {
  await Promise.all(
    dirsToClean.map(dir => rm(dir, { recursive: true, force: true })),
  )
  dirsToClean = []
})

describe('legacy attribution snapshots in transcript loading', () => {
  test('loadTranscriptFile ignores old attribution snapshot entries', async () => {
    const file = await tempFile(
      [
        attributionSnapshotLine(),
        transcriptMessage(USER_ID, null, 'user'),
        attributionSnapshotLine(USER_ID),
        transcriptMessage(ASSISTANT_ID, USER_ID, 'assistant'),
        attributionSnapshotLine(ASSISTANT_ID),
      ].join('\n') + '\n',
    )

    const result = await loadTranscriptFile(file)

    expect(result.messages.size).toBe(2)
    expect(result.messages.has(USER_ID)).toBe(true)
    expect(result.messages.has(ASSISTANT_ID)).toBe(true)
    expect(result.leafUuids.has(ASSISTANT_ID)).toBe(true)
    expect('attributionSnapshots' in result).toBe(false)
  })
})

describe('readTranscriptForLoad legacy attribution snapshot stripping', () => {
  test('drops attribution snapshot lines split across chunk boundaries', async () => {
    const attrLine = attributionSnapshotLine() + '\n'
    const prefixBytesInFirstChunk = 10
    const keep = 'keep-before\n'
    const fillerLength = CHUNK_SIZE - prefixBytesInFirstChunk - keep.length
    const filler = `${'p'.repeat(fillerLength - 1)}\n`
    const file = await tempFile(`${keep}${filler}${attrLine}keep-after\n`)

    const output = await readForLoadString(file)

    expect(output).toContain('keep-before\n')
    expect(output).toContain('keep-after\n')
    expect(output).not.toContain('attribution-snapshot')
  })

  test('does not append a final attribution snapshot at EOF', async () => {
    const file = await tempFile(`kept\n${attributionSnapshotLine()}`)

    const output = await readForLoadString(file)

    expect(output).toBe('kept\n')
    expect(output).not.toContain('attribution-snapshot')
  })

  test('truncates at compact boundaries without preserved segments', async () => {
    const boundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
    })
    const file = await tempFile(`old\n${boundary}\nnew\n`)

    const output = await readForLoadString(file)

    expect(output).not.toContain('old\n')
    expect(output).toContain(`${boundary}\nnew\n`)
  })

  test('keeps preserved-segment compact boundary content', async () => {
    const boundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { preservedSegment: { messageIds: [USER_ID] } },
    })
    const file = await tempFile(`old\n${boundary}\nnew\n`)

    const output = await readForLoadString(file)

    expect(output).toContain('old\n')
    expect(output).toContain(`${boundary}\nnew\n`)
  })
})
