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
import { getSystemPrompt } from '../../src/constants/prompts.js'
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

beforeEach(() => {
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

afterEach(() => {
  resetProviderRegistry()
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

  test('is stable across repeated builds', async () => {
    const first = await systemPromptText()
    const second = await systemPromptText()
    expect(second).toBe(first)
  })
})
