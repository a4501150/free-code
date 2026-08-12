import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUILT_IN_OUTPUT_STYLES,
  clearOutputStyleCaches,
  DEFAULT_OUTPUT_STYLE_NAME,
  NO_OUTPUT_STYLE_NAME,
  resolveOutputStyle,
  resolveOutputStyleName,
} from '../../src/outputStyles/outputStyles.js'

let configDir: string
let projectDir: string

async function writeStyle(
  dir: string,
  fileName: string,
  content: string,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), content)
  clearOutputStyleCaches()
}

function userStylesDir(): string {
  return join(configDir, 'output-styles')
}

function projectStylesDir(): string {
  return join(projectDir, '.freecode', 'output-styles')
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'output-styles-home-'))
  projectDir = await mkdtemp(join(tmpdir(), 'output-styles-project-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  clearOutputStyleCaches()
})

afterEach(async () => {
  delete process.env.FREECODE_CONFIG_DIR
  clearOutputStyleCaches()
  await rm(configDir, { recursive: true, force: true })
  await rm(projectDir, { recursive: true, force: true })
})

describe('built-in styles', () => {
  test('are exactly none and simple-english', () => {
    expect(Object.keys(BUILT_IN_OUTPUT_STYLES)).toEqual([
      NO_OUTPUT_STYLE_NAME,
      DEFAULT_OUTPUT_STYLE_NAME,
    ])
  })

  test('none maps to no style', () => {
    expect(BUILT_IN_OUTPUT_STYLES[NO_OUTPUT_STYLE_NAME]).toBeNull()
  })

  test('simple-english layers on top of the existing prompt', () => {
    const style = BUILT_IN_OUTPUT_STYLES[DEFAULT_OUTPUT_STYLE_NAME]
    expect(style?.keepCodingInstructions).toBe(true)
    expect(style?.keepResponseStyle).toBe(true)
    expect(style?.source).toBe('built-in')
    expect(style?.prompt).not.toContain(configDir)
  })
})

describe('name resolution', () => {
  test('unset and default both select simple-english', () => {
    expect(resolveOutputStyleName(undefined)).toBe(DEFAULT_OUTPUT_STYLE_NAME)
    expect(resolveOutputStyleName('')).toBe(DEFAULT_OUTPUT_STYLE_NAME)
    expect(resolveOutputStyleName('  ')).toBe(DEFAULT_OUTPUT_STYLE_NAME)
    expect(resolveOutputStyleName('default')).toBe(DEFAULT_OUTPUT_STYLE_NAME)
  })

  test('other values pass through, trimmed', () => {
    expect(resolveOutputStyleName('none')).toBe('none')
    expect(resolveOutputStyleName(' socratic ')).toBe('socratic')
  })
})

describe('resolving the active style', () => {
  test('unset selects simple-english', async () => {
    const style = await resolveOutputStyle(projectDir, undefined)
    expect(style?.name).toBe(DEFAULT_OUTPUT_STYLE_NAME)
  })

  test('none disables styling', async () => {
    expect(await resolveOutputStyle(projectDir, 'none')).toBeNull()
  })

  test('an unknown name behaves as unset', async () => {
    const style = await resolveOutputStyle(projectDir, 'no-such-style')
    expect(style?.name).toBe(DEFAULT_OUTPUT_STYLE_NAME)
  })

  test('a user style is found and its flags parsed', async () => {
    await writeStyle(
      userStylesDir(),
      'socratic.md',
      `---
name: socratic
description: Asks before it answers
keep-coding-instructions: true
---
Ask one question first.`,
    )

    const style = await resolveOutputStyle(projectDir, 'socratic')
    expect(style).toMatchObject({
      name: 'socratic',
      description: 'Asks before it answers',
      prompt: 'Ask one question first.',
      source: 'userSettings',
      keepCodingInstructions: true,
      keepResponseStyle: false,
    })
  })

  test('the filename names a style with no frontmatter name', async () => {
    await writeStyle(userStylesDir(), 'terse.md', 'Say less.')

    const style = await resolveOutputStyle(projectDir, 'terse')
    expect(style?.prompt).toBe('Say less.')
  })

  test('a project style shadows a user style of the same name', async () => {
    await writeStyle(userStylesDir(), 'shared.md', 'From the user directory.')
    await writeStyle(
      projectStylesDir(),
      'shared.md',
      'From the project directory.',
    )

    const style = await resolveOutputStyle(projectDir, 'shared')
    expect(style?.source).toBe('projectSettings')
    expect(style?.prompt).toBe('From the project directory.')
  })

  test('reserved names are not definable', async () => {
    await writeStyle(userStylesDir(), 'none.md', 'Should be ignored.')
    await writeStyle(userStylesDir(), 'default.md', 'Should be ignored too.')

    expect(await resolveOutputStyle(projectDir, 'none')).toBeNull()
    const aliased = await resolveOutputStyle(projectDir, 'default')
    expect(aliased?.source).toBe('built-in')
  })

  test('an empty body is not a style', async () => {
    await writeStyle(
      userStylesDir(),
      'blank.md',
      `---
name: blank
---
`,
    )

    const style = await resolveOutputStyle(projectDir, 'blank')
    expect(style?.name).toBe(DEFAULT_OUTPUT_STYLE_NAME)
  })

  test('clearing the caches picks up a new style file', async () => {
    expect((await resolveOutputStyle(projectDir, 'late'))?.name).toBe(
      DEFAULT_OUTPUT_STYLE_NAME,
    )

    await writeStyle(userStylesDir(), 'late.md', 'Added after the first read.')

    expect((await resolveOutputStyle(projectDir, 'late'))?.name).toBe('late')
  })
})
