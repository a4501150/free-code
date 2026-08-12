/**
 * The system prompt must stay byte-identical across sessions, projects and
 * machines for a given version. That is what lets a brand-new session in a new
 * directory *read* the cached system prefix instead of writing it.
 *
 * Session-scoped facts belong in the prepended user-context message (assembled
 * in query.ts from getUserContext + getSystemContext + getEnvContext), never in
 * the system prompt. This guards that split — it is easy to reintroduce a cwd
 * or a session path into a prompt section without noticing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSystemPrompt } from '../../src/constants/prompts.js'
import {
  clearOutputStyleCaches,
  resetActiveOutputStyle,
} from '../../src/outputStyles/outputStyles.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { Tools } from '../../src/Tool.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
// The developer's own ~/.freecode may hold an output style or an outputStyle
// setting, either of which would put its bytes in the prompt under test.
let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'static-system-prompt-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  resetSettingsCache()
  resetActiveOutputStyle()
  clearOutputStyleCaches()
  resetProviderRegistry()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const providers: Record<string, ProviderConfig> = {
    anthropic: {
      type: 'anthropic',
      baseUrl: 'http://anthropic.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'claude-test' }],
    },
  }
  initProviderRegistry(providers)
})

afterEach(async () => {
  resetProviderRegistry()
  delete process.env.FREECODE_CONFIG_DIR
  resetSettingsCache()
  resetActiveOutputStyle()
  clearOutputStyleCaches()
  await rm(configDir, { recursive: true, force: true })
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

async function systemPromptText(): Promise<string> {
  const sections = await getSystemPrompt([] as unknown as Tools, 'claude-test')
  return sections.join('\n\n')
}

describe('system prompt is free of session-scoped bytes', () => {
  test('does not contain the current working directory', async () => {
    const prompt = await systemPromptText()
    expect(prompt).not.toContain(process.cwd())
  })

  test('does not contain a scratchpad or session path', async () => {
    const prompt = await systemPromptText()
    expect(prompt).not.toContain('# Scratchpad Directory')
    expect(prompt).not.toMatch(/scratchpad/i)
  })

  test('does not contain the environment block', async () => {
    // computeSimpleEnvInfo (cwd, platform, shell, OS version, model, settings
    // paths) moved to the user context — it varies per machine and project.
    const prompt = await systemPromptText()
    expect(prompt).not.toContain('# Environment')
    expect(prompt).not.toContain('Primary working directory')
  })

  test('does not contain the model id', async () => {
    const prompt = await systemPromptText()
    expect(prompt).not.toContain('claude-test')
  })

  test('does not contain an output style source path', async () => {
    // The built-in style is bundled as source; custom and plugin styles come
    // from disk, and only their name and body may reach the prompt.
    const prompt = await systemPromptText()
    expect(prompt).toContain('# Output Style: simple-english')
    expect(prompt).not.toContain(configDir)
    expect(prompt).not.toContain('output-styles')
  })

  test('is stable across repeated builds', async () => {
    const first = await systemPromptText()
    const second = await systemPromptText()
    expect(second).toBe(first)
  })
})
