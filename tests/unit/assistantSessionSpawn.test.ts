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
// process-wide in the shared unit-test process. The factory spreads the real
// namespace because Bun replaces the module wholesale for later loads — a
// bare single-export factory would strip every other settings export from
// files that import them after this one runs. The persona/coordinator latches
// are patched too: they are process-global, and this test must not flip them
// for the files that run after it.
let testSettings: Record<string, unknown> = {}
const actualSettings = await import('../../src/utils/settings/settings.js')
mock.module('../../src/utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => testSettings,
}))
mock.module('../../src/assistant/index.js', () => ({
  markAssistantForced: () => {},
}))
mock.module('../../src/coordinator/coordinatorModeGate.js', () => ({
  forceCoordinatorModeFromCli: () => {},
}))

const { assistantWorkspaceDir, bootstrapAssistantSession } =
  await import('../../src/sessiond/assistant.js')
const configModule = await import('../../src/utils/config.js')
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
  configModule.resetTrustDialogAcceptedCacheForTesting()
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

/**
 * The headless child gates assistant-mode activation on a persisted trust
 * record and has no UI to accept the dialog, so bootstrap writes one for the
 * assistant workspace before spawning.
 */
describe('bootstrapAssistantSession workspace trust', () => {
  test('persists trust for the assistant workspace before spawning', async () => {
    expect(configModule.isPathTrusted(assistantWorkspaceDir())).toBe(false)
    const child = await bootstrapAssistantSession(fakeRegistry())
    expect(child).not.toBeNull()
    expect(configModule.isPathTrusted(assistantWorkspaceDir())).toBe(true)
  })

  test('the opt-out starts nothing and writes no trust record', async () => {
    testSettings = { assistant: { enabled: false } }
    await bootstrapAssistantSession(fakeRegistry())
    expect(configModule.isPathTrusted(assistantWorkspaceDir())).toBe(false)
  })
})
