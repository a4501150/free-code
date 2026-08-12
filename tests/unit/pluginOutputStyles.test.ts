import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PluginManifestSchema } from '../../src/utils/plugins/schemas.js'
import { validatePluginContents } from '../../src/utils/plugins/validatePlugin.js'

const BASE_MANIFEST = { name: 'styler', version: '1.0.0' }

describe('plugin manifest outputStyles', () => {
  test('accepts one path and a list of paths', () => {
    expect(
      PluginManifestSchema.safeParse({
        ...BASE_MANIFEST,
        outputStyles: './styles/socratic.md',
      }).success,
    ).toBe(true)
    expect(
      PluginManifestSchema.safeParse({
        ...BASE_MANIFEST,
        outputStyles: ['./styles/socratic.md', './extra/terse.md'],
      }).success,
    ).toBe(true)
  })

  test('rejects absolute paths, escaping paths and non-markdown', () => {
    for (const outputStyles of [
      '/etc/passwd.md',
      '../outside/style.md',
      './styles/socratic.txt',
    ]) {
      expect(
        PluginManifestSchema.safeParse({ ...BASE_MANIFEST, outputStyles })
          .success,
      ).toBe(false)
    }
  })
})

describe('validating a plugin output-styles directory', () => {
  let pluginDir: string

  beforeEach(async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'plugin-output-styles-'))
    await mkdir(join(pluginDir, 'output-styles'), { recursive: true })
  })

  afterEach(async () => {
    await rm(pluginDir, { recursive: true, force: true })
  })

  async function writeStyle(fileName: string, body: string): Promise<void> {
    await writeFile(join(pluginDir, 'output-styles', fileName), body)
  }

  test('a well-formed style reports nothing', async () => {
    await writeStyle(
      'socratic.md',
      `---
name: socratic
description: Asks before it answers
keep-coding-instructions: true
force-for-plugin: false
---
Ask one question first.`,
    )

    expect(await validatePluginContents(pluginDir)).toEqual([])
  })

  test('a non-boolean keep flag is an error against that file', async () => {
    await writeStyle(
      'broken.md',
      `---
name: broken
description: Bad flags
keep-response-style: yes please
---
Body.`,
    )

    const results = await validatePluginContents(pluginDir)
    expect(results).toHaveLength(1)
    expect(results[0]?.fileType).toBe('output-style')
    expect(results[0]?.errors.map(e => e.path)).toContain('keep-response-style')
  })

  test('a missing description is a warning, not an error', async () => {
    await writeStyle(
      'terse.md',
      `---
name: terse
---
Say less.`,
    )

    const results = await validatePluginContents(pluginDir)
    expect(results).toHaveLength(1)
    expect(results[0]?.errors).toEqual([])
    expect(results[0]?.warnings.map(w => w.path)).toContain('description')
  })
})
