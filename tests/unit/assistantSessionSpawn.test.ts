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
// process-wide in the shared unit-test process. Only this one export is
// patched — Bun merges the patch over the real namespace, so other exports
// stay real for later files.
let testSettings: Record<string, unknown> = {}
mock.module('../../src/utils/settings/settings.js', () => ({
  getInitialSettings: () => testSettings,
}))

const { bootstrapAssistantSession } =
  await import('../../src/webui/gateway/assistantSession.js')
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
