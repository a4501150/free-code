import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDumpPromptsFetch } from '../../src/services/api/dumpPrompts.js'

// Chat-completions providers carry the system prompt as a role:'system' entry
// inside messages, so the append-only user-message slice never captures it.
// The dumper must write it and re-write it when its content changes.

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalFetch = globalThis.fetch
const configDir = mkdtempSync(join(tmpdir(), 'dump-prompts-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir

const AGENT_ID = 'dump-system-msg-test'
const DUMP_PATH = join(configDir, 'dump-prompts', `${AGENT_ID}.jsonl`)

function readEntries(): Array<{ type: string; data?: { role?: string } }> {
  try {
    return readFileSync(DUMP_PATH, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
  } catch {
    return []
  }
}

function systemEntries(): string[] {
  return readEntries()
    .filter(e => e.type === 'message' && e.data?.role === 'system')
    .map(e => JSON.stringify(e.data))
}

async function post(fetchImpl: typeof globalThis.fetch, body: unknown) {
  await fetchImpl('http://provider.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  // dumpRequest runs via setImmediate and appends through a promise chain.
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5))
}

function chatBody(systemText: string, userTexts: string[]) {
  return {
    model: 'test-model',
    messages: [
      { role: 'system', content: systemText },
      ...userTexts.map(content => ({ role: 'user', content })),
    ],
    tools: [{ type: 'function', function: { name: 'Read' } }],
  }
}

beforeAll(() => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    void init
    return new Response('{"choices":[]}', {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
})

describe('dumpPrompts in-messages system prompt', () => {
  const dumpingFetch = createDumpPromptsFetch(AGENT_ID)

  test('writes the system message on the first request', async () => {
    await post(dumpingFetch, chatBody('SYS v1', ['hello']))
    const sys = systemEntries()
    expect(sys.length).toBe(1)
    expect(sys[0]).toContain('SYS v1')
  })

  test('does not duplicate the system message on unchanged turns', async () => {
    await post(dumpingFetch, chatBody('SYS v1', ['hello', 'second turn']))
    expect(systemEntries().length).toBe(1)
  })

  test('writes a new system message entry when content changes', async () => {
    await post(dumpingFetch, chatBody('SYS v2', ['hello', 'second', 'third']))
    const sys = systemEntries()
    expect(sys.length).toBe(2)
    expect(sys[1]).toContain('SYS v2')
  })
})
