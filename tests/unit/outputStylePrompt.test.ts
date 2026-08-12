/**
 * An output style replaces parts of the system prompt: the coding group
 * (`# Doing tasks`, `# Code style`) and the response group (`# Response style`)
 * are dropped unless the style opts to keep them, and the intro says the style
 * is the role when the style drops the coding instructions.
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

const CODING_SECTIONS = ['# Doing tasks', '# Code style']
const RESPONSE_SECTION = '# Response style'
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
    for (const section of [...CODING_SECTIONS, RESPONSE_SECTION]) {
      expect(prompt).toContain(section)
    }
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
    for (const section of [...CODING_SECTIONS, RESPONSE_SECTION]) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toContain('with software engineering tasks')
  })
})

describe('section gating', () => {
  test('a style with neither flag replaces both groups and the role', async () => {
    await writeStyle('novelist', '')
    await writeSettings('novelist')
    const prompt = await systemPromptText()

    expect(prompt).toContain('# Output Style: novelist')
    for (const section of [...CODING_SECTIONS, RESPONSE_SECTION]) {
      expect(prompt).not.toContain(section)
    }
    expect(prompt).toContain(STYLE_ROLE_INTRO)
    expect(prompt).not.toContain('with software engineering tasks')
  })

  test('keep-coding-instructions keeps the coding group and the role', async () => {
    await writeStyle('coder', 'keep-coding-instructions: true\n')
    await writeSettings('coder')
    const prompt = await systemPromptText()

    for (const section of CODING_SECTIONS) {
      expect(prompt).toContain(section)
    }
    expect(prompt).not.toContain(RESPONSE_SECTION)
    expect(prompt).toContain('with software engineering tasks')
  })

  test('keep-response-style keeps only the response group', async () => {
    await writeStyle('chatty', 'keep-response-style: true\n')
    await writeSettings('chatty')
    const prompt = await systemPromptText()

    for (const section of CODING_SECTIONS) {
      expect(prompt).not.toContain(section)
    }
    expect(prompt).toContain(RESPONSE_SECTION)
    expect(prompt).toContain(STYLE_ROLE_INTRO)
  })

  test('# Text output survives every combination', async () => {
    await writeStyle('novelist', '')
    await writeSettings('novelist')
    const prompt = await systemPromptText()
    expect(prompt).toContain('# Text output')
    expect(prompt).toContain('Report outcomes faithfully')
  })
})

describe('section layout', () => {
  test('the comment policy moved into # Code style, once', async () => {
    const prompt = await systemPromptText()
    const marker = 'Default to writing no comments'
    expect(prompt.split(marker)).toHaveLength(2)
    expect(prompt.indexOf('# Code style')).toBeLessThan(prompt.indexOf(marker))
    expect(prompt.indexOf(marker)).toBeLessThan(
      prompt.indexOf('# Executing actions with care'),
    )
  })

  test('groups run text output, response style, then the style', async () => {
    const prompt = await systemPromptText()
    expect(prompt.indexOf('# Text output')).toBeLessThan(
      prompt.indexOf(RESPONSE_SECTION),
    )
    expect(prompt.indexOf(RESPONSE_SECTION)).toBeLessThan(
      prompt.indexOf('# Output Style'),
    )
  })
})
