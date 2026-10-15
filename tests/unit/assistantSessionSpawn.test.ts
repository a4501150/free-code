/**
 * The assistant session's start defaults: permission checks are bypassed by
 * default (nobody is attached to answer its prompts), swappable through
 * assistant.dangerouslySkipPermissions without any CLI parameter.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// getInitialSettings is patched locally (mutable, like memoryPromptPaths)
// rather than driven through a real freecode.json: mock.module is
// process-wide in the shared unit-test process. Only these exports are
// patched — Bun merges the patch over the real namespace, so other exports
// stay real for later files. The persona/coordinator latches are patched
// too: they are process-global, and this test must not flip them for the
// files that run after it.
let testSettings: Record<string, unknown> = {}
mock.module('../../src/utils/settings/settings.js', () => ({
  getInitialSettings: () => testSettings,
}))
mock.module('../../src/assistant/index.js', () => ({
  markAssistantForced: () => {},
}))
mock.module('../../src/coordinator/coordinatorModeGate.js', () => ({
  forceCoordinatorModeFromCli: () => {},
}))

const { bootstrapAssistantSession } =
  await import('../../src/sessiond/assistant.js')
const { SettingsSchema } = await import('../../src/utils/settings/types.js')

type Defaults = { permissionMode?: string }
type StartOptions = { cwd: string; defaults?: Defaults }

let started: StartOptions[]

function fakeRegistry(): Parameters<typeof bootstrapAssistantSession>[0] {
  const start = async (options: StartOptions) => {
    started.push(options)
    return { sessionId: 'session' }
  }
  return {
    create: start,
    resume: start,
  } as unknown as Parameters<typeof bootstrapAssistantSession>[0]
}

let configDir: string

beforeEach(async () => {
  testSettings = {}
  started = []
  configDir = await mkdtemp(join(tmpdir(), 'assistant-spawn-'))
  process.env.FREECODE_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.FREECODE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

describe('bootstrapAssistantSession defaults', () => {
  test('starts with bypass permissions by default', async () => {
    const entry = await bootstrapAssistantSession(fakeRegistry())
    expect(entry).not.toBeNull()
    expect(started[0]!.defaults?.permissionMode).toBe('bypassPermissions')
  })

  test('assistant.dangerouslySkipPermissions: false keeps it gated', async () => {
    testSettings = { assistant: { dangerouslySkipPermissions: false } }
    await bootstrapAssistantSession(fakeRegistry())
    expect(started[0]!.defaults?.permissionMode).toBeUndefined()
  })

  test('assistant.enabled: false starts nothing', async () => {
    testSettings = { assistant: { enabled: false } }
    expect(await bootstrapAssistantSession(fakeRegistry())).toBeNull()
    expect(started).toHaveLength(0)
  })

  test('settings schema accepts the opt-out key', () => {
    expect(
      SettingsSchema()
        .strict()
        .safeParse({
          assistant: { dangerouslySkipPermissions: false },
        }).success,
    ).toBe(true)
  })
})
