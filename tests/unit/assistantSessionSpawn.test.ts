/**
 * The assistant child's spawn flags: permission checks are bypassed by
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
// files that import them after this one runs.
let testSettings: Record<string, unknown> = {}
const actualSettings = await import('../../src/utils/settings/settings.js')
mock.module('../../src/utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => testSettings,
}))

const { assistantWorkspaceDir, bootstrapAssistantSession } =
  await import('../../src/webui/gateway/assistantSession.js')
const configModule = await import('../../src/utils/config.js')
const { SettingsSchema } = await import('../../src/utils/settings/types.js')

type StartOptions = {
  cwd: string
  resumeSessionId?: string
  extraArgs?: string[]
}

let started: StartOptions[]

function fakeChildren(): Parameters<typeof bootstrapAssistantSession>[0] {
  return {
    start: async (options: StartOptions) => {
      started.push(options)
      return {
        pid: 1,
        processKey: '1:x',
        cwd: options.cwd,
        sessionId: 'session',
      }
    },
    stop: () => false,
    stopAll: () => {},
    owns: () => false,
  } as Parameters<typeof bootstrapAssistantSession>[0]
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

describe('bootstrapAssistantSession spawn flags', () => {
  test('spawns with bypass permissions by default', async () => {
    const child = await bootstrapAssistantSession(fakeChildren())
    expect(child).not.toBeNull()
    expect(started[0]!.extraArgs).toContain('--assistant')
    expect(started[0]!.extraArgs).toContain('--dangerously-skip-permissions')
  })

  test('assistant.dangerouslySkipPermissions: false keeps it gated', async () => {
    testSettings = { assistant: { dangerouslySkipPermissions: false } }
    await bootstrapAssistantSession(fakeChildren())
    expect(started[0]!.extraArgs).toContain('--assistant')
    expect(started[0]!.extraArgs).not.toContain(
      '--dangerously-skip-permissions',
    )
  })

  test('assistant.enabled: false starts nothing', async () => {
    testSettings = { assistant: { enabled: false } }
    expect(await bootstrapAssistantSession(fakeChildren())).toBeNull()
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
    const child = await bootstrapAssistantSession(fakeChildren())
    expect(child).not.toBeNull()
    expect(configModule.isPathTrusted(assistantWorkspaceDir())).toBe(true)
  })

  test('the opt-out starts nothing and writes no trust record', async () => {
    testSettings = { assistant: { enabled: false } }
    await bootstrapAssistantSession(fakeChildren())
    expect(configModule.isPathTrusted(assistantWorkspaceDir())).toBe(false)
  })
})
