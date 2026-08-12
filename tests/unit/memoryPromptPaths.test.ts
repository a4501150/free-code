/**
 * The memory prompt is half the system prompt and the only section that ever
 * named a directory. Interpolating one made the cached system prefix
 * per-project; the paths now travel in the environment block of the user
 * context, which is per-project anyway.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildMemoryLines,
  getMemoryEnvItems,
  loadMemoryPrompt,
  MEMORY_DIR_ENV_LABEL,
  TRANSCRIPT_DIR_ENV_LABEL,
} from '../../src/memdir/memdir.js'
import { getAutoMemPath } from '../../src/memdir/paths.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'memory-prompt-paths-'))
  await writeFile(join(configDir, 'freecode.json'), '{}')
  process.env.FREECODE_CONFIG_DIR = configDir
  resetSettingsCache()
})

afterEach(async () => {
  delete process.env.FREECODE_CONFIG_DIR
  resetSettingsCache()
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
    // The env var is checked ahead of settings, so this holds whatever the
    // process-wide settings cache currently holds.
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    try {
      expect(getMemoryEnvItems()).toEqual([])
      expect(await loadMemoryPrompt()).toBeNull()
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    }
  })
})

describe('agent memory', () => {
  test('still gets a literal directory, having no environment block', () => {
    const lines = buildMemoryLines('agent memory', '/tmp/agent-memory/')
    expect(lines.join('\n')).toContain('/tmp/agent-memory/')
  })
})
