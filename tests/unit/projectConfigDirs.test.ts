import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getMemoryFilesForNestedDirectory,
  isMemoryFilePath,
} from '../../src/utils/claudemd.js'
import { getProjectDirsUpToHome } from '../../src/utils/markdownConfigLoader.js'

let tmpDir: string | undefined

function makeTempDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'project-config-dirs-'))
  return tmpDir
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

describe('project config directory discovery', () => {
  test('markdown config loader scans .claude before .freecode project directories', () => {
    const projectRoot = makeTempDir()
    const nestedCwd = join(projectRoot, 'src', 'nested')
    mkdirSync(nestedCwd, { recursive: true })
    mkdirSync(join(projectRoot, '.claude', 'commands'), { recursive: true })
    mkdirSync(join(projectRoot, '.freecode', 'commands'), { recursive: true })

    expect(getProjectDirsUpToHome('commands', nestedCwd)).toEqual([
      join(projectRoot, '.claude', 'commands'),
      join(projectRoot, '.freecode', 'commands'),
    ])
  })

  test('CLAUDE.md discovery loads .freecode entries after legacy .claude entries', async () => {
    const projectRoot = makeTempDir()
    mkdirSync(join(projectRoot, '.claude', 'rules'), { recursive: true })
    mkdirSync(join(projectRoot, '.freecode', 'rules'), { recursive: true })
    writeFileSync(
      join(projectRoot, '.claude', 'CLAUDE.md'),
      'legacy instructions\n',
    )
    writeFileSync(
      join(projectRoot, '.claude', 'rules', 'legacy.md'),
      'legacy rules\n',
    )
    writeFileSync(
      join(projectRoot, '.freecode', 'CLAUDE.md'),
      'preferred instructions\n',
    )
    writeFileSync(
      join(projectRoot, '.freecode', 'rules', 'preferred.md'),
      'preferred rules\n',
    )

    const files = await getMemoryFilesForNestedDirectory(
      projectRoot,
      join(projectRoot, 'src', 'file.ts'),
      new Set(),
    )

    expect(files.map(file => file.content.trim())).toEqual([
      'legacy instructions',
      'preferred instructions',
      'legacy rules',
      'preferred rules',
    ])
  })

  test('memory file detection includes .freecode rules', () => {
    expect(
      isMemoryFilePath(join('project', '.freecode', 'rules', 'style.md')),
    ).toBe(true)
    expect(isMemoryFilePath(join('project', '.freecode', 'CLAUDE.md'))).toBe(
      true,
    )
    expect(isMemoryFilePath(join('project', '.freecode', 'notes.md'))).toBe(
      false,
    )
  })
})
