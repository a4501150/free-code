/**
 * An output style replaces parts of the system prompt: the response group
 * (`# Communicating with the user`) is dropped unless the style opts to keep
 * it, and the intro says the style is the role when the style drops the
 * coding instructions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSystemPrompt } from '../../src/constants/prompts.js'
import {
  clearOutputStyleCaches,
  resetActiveOutputStyle,
} from '../../src/outputStyles/outputStyles.js'
import type { Tools } from '../../src/Tool.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

const RESPONSE_SECTION = '# Communicating with the user'
const STYLE_ROLE_INTRO = 'according to your "Output Style" below'

let configDir: string
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY

async function writeSettings(outputStyle?: string): Promise<void> {
  await writeFile(
    join(configDir, 'freecode.json'),
    JSON.stringify(outputStyle === undefined ? {} : { outputStyle }),
  )
  resetSettingsCache()
  resetActiveOutputStyle()
  clearOutputStyleCaches()
}

async function writeStyle(
  name: string,
  frontmatter: string,
  body = 'Style body.',
): Promise<void> {
  const dir = join(configDir, 'output-styles')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: A test style\n${frontmatter}---\n${body}`,
  )
  clearOutputStyleCaches()
}

async function systemPromptText(): Promise<string> {
  const sections = await getSystemPrompt([] as unknown as Tools, 'claude-test')
  return sections.join('\n\n')
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'output-style-prompt-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  process.env.ANTHROPIC_API_KEY = 'test-key'
  resetProviderRegistry()
  const providers: Record<string, ProviderConfig> = {
    anthropic: {
      type: 'anthropic',
      baseUrl: 'http://anthropic.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'claude-test' }],
    },
  }
  initProviderRegistry(providers)
  await writeSettings(undefined)
})

afterEach(async () => {
  resetProviderRegistry()
  delete process.env.FREECODE_CONFIG_DIR
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
  resetSettingsCache()
  resetActiveOutputStyle()
  clearOutputStyleCaches()
  await rm(configDir, { recursive: true, force: true })
})

describe('the default session', () => {
  test('carries simple-english and keeps every section', async () => {
    const prompt = await systemPromptText()
    expect(prompt).toContain('# Output Style: simple-english')
    expect(prompt).toContain('Simplified Technical English')
    expect(prompt).toContain(RESPONSE_SECTION)
    expect(prompt).toContain('# Harness')
    expect(prompt).toContain('with software engineering tasks')
    expect(prompt).not.toContain(STYLE_ROLE_INTRO)
  })

  test('carries no style source path', async () => {
    await writeStyle('pathy', 'keep-coding-instructions: true\n')
    await writeSettings('pathy')
    const prompt = await systemPromptText()
    expect(prompt).toContain('# Output Style: pathy')
    expect(prompt).not.toContain(configDir)
  })
})

describe('outputStyle: none', () => {
  test('renders no style section and keeps every section', async () => {
    await writeSettings('none')
    const prompt = await systemPromptText()
    expect(prompt).not.toContain('# Output Style')
    expect(prompt).toContain(RESPONSE_SECTION)
    expect(prompt).toContain('# Harness')
    expect(prompt).toContain('with software engineering tasks')
  })
})

describe('section gating', () => {
  test('a style with neither flag replaces both groups and the role', async () => {
    await writeStyle('novelist', '')
    await writeSettings('novelist')
    const prompt = await systemPromptText()

    expect(prompt).toContain('# Output Style: novelist')
    expect(prompt).not.toContain(RESPONSE_SECTION)
    expect(prompt).toContain(STYLE_ROLE_INTRO)
    expect(prompt).not.toContain('with software engineering tasks')
  })

  test('keep-coding-instructions keeps the coding group and the role', async () => {
    await writeStyle('coder', 'keep-coding-instructions: true\n')
    await writeSettings('coder')
    const prompt = await systemPromptText()

    expect(prompt).toContain('# Harness')
    expect(prompt).not.toContain(RESPONSE_SECTION)
    expect(prompt).toContain('with software engineering tasks')
  })

  test('keep-response-style keeps only the response group', async () => {
    await writeStyle('chatty', 'keep-response-style: true\n')
    await writeSettings('chatty')
    const prompt = await systemPromptText()

    expect(prompt).not.toContain('# Doing tasks')
    expect(prompt).toContain(RESPONSE_SECTION)
    expect(prompt).toContain(STYLE_ROLE_INTRO)
  })

  test('action caution survives every combination', async () => {
    await writeStyle('novelist', '')
    await writeSettings('novelist')
    const prompt = await systemPromptText()
    expect(prompt).toContain('Report outcomes faithfully')
  })
})

describe('section layout', () => {
  test('the comment policy sits in the response section, once', async () => {
    const prompt = await systemPromptText()
    const marker = 'Write a comment only for a constraint'
    expect(prompt.split(marker)).toHaveLength(2)
    expect(prompt.indexOf(RESPONSE_SECTION)).toBeLessThan(
      prompt.indexOf(marker),
    )
    expect(prompt.indexOf(marker)).toBeLessThan(
      prompt.indexOf('# Context management'),
    )
  })

  test('groups run harness, caution, response, then the style', async () => {
    const prompt = await systemPromptText()
    expect(prompt.indexOf('# Harness')).toBeLessThan(
      prompt.indexOf('For actions that are hard to reverse'),
    )
    expect(prompt.indexOf('For actions that are hard to reverse')).toBeLessThan(
      prompt.indexOf(RESPONSE_SECTION),
    )
    expect(prompt.indexOf(RESPONSE_SECTION)).toBeLessThan(
      prompt.indexOf('# Output Style'),
    )
  })
})
