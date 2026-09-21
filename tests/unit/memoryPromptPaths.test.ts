/**
 * The memory prompt is half the system prompt and the only section that ever
 * named a directory. Interpolating one made the cached system prefix
 * per-project; the paths now travel in the environment block of the user
 * context, which is per-project anyway.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// getInitialSettings is patched locally (mutable, like attribution.test.ts)
// rather than driven through a real freecode.json: mock.module is
// process-wide in the shared unit-test process, so a file that already mocks
// settings.js (alphabetically earlier ones do) would shadow disk-loaded
// config for this file too. Only this one export is patched — Bun merges the
// patch over the real namespace, and leaking a getSettingsForSource stub
// would break later files.
let testSettings: Record<string, unknown> = {}
mock.module('../../src/utils/settings/settings.js', () => ({
  getInitialSettings: () => testSettings,
}))

const {
  buildMemoryLines,
  getMemoryEnvItems,
  loadMemoryPrompt,
  MEMORY_DIR_ENV_LABEL,
  TRANSCRIPT_DIR_ENV_LABEL,
} = await import('../../src/memdir/memdir.js')
const { getAutoMemPath } = await import('../../src/memdir/paths.js')

let configDir: string

beforeEach(async () => {
  testSettings = {}
  configDir = await mkdtemp(join(tmpdir(), 'memory-prompt-paths-'))
  process.env.FREECODE_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.FREECODE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

describe('the main thread memory prompt', () => {
  test('names its directory instead of interpolating it', async () => {
    const prompt = await loadMemoryPrompt()
    expect(prompt).not.toBeNull()
    // getAutoMemPath is memoized process-wide, so compare against whatever it
    // currently resolves to rather than against this test's config dir.
    expect(prompt).not.toContain(getAutoMemPath())
    expect(prompt).toContain(MEMORY_DIR_ENV_LABEL)
  })

  test('leaves the search commands as substitutable placeholders', async () => {
    const prompt = await loadMemoryPrompt()
    expect(prompt).toContain(`<${MEMORY_DIR_ENV_LABEL}>`)
    expect(prompt).toContain(`<${TRANSCRIPT_DIR_ENV_LABEL}>`)
  })
})

describe('the environment items', () => {
  test('carry the real paths the prompt refers to', () => {
    const items = getMemoryEnvItems()
    expect(items[0]).toBe(`${MEMORY_DIR_ENV_LABEL}: ${getAutoMemPath()}`)
    expect(items.some(item => item.startsWith(TRANSCRIPT_DIR_ENV_LABEL))).toBe(
      true,
    )
  })

  test('are empty when memory is off', async () => {
    testSettings = { autoMemoryEnabled: false }
    expect(getMemoryEnvItems()).toEqual([])
    expect(await loadMemoryPrompt()).toBeNull()
  })
})

describe('agent memory', () => {
  test('still gets a literal directory, having no environment block', () => {
    const lines = buildMemoryLines('agent memory', '/tmp/agent-memory/')
    expect(lines.join('\n')).toContain('/tmp/agent-memory/')
  })
})
