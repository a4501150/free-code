import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  remapInstalledPluginPaths,
  remapKnownMarketplacesConfigWithDirs,
  remapLegacyHomePluginPath,
  type LegacyHomeRemapDirs,
} from '../../src/utils/plugins/legacyHomePaths.js'
import { rewriteMigratedPluginStatePaths } from '../../src/utils/settings/claudeMigration.js'

let tmpDir: string | undefined

function makeTempDir(prefix: string): string {
  tmpDir = mkdtempSync(join(tmpdir(), prefix))
  return tmpDir
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

function makeDirs(): LegacyHomeRemapDirs & { legacyHome: string } {
  const root = makeTempDir('legacy-home-paths-')
  const legacyHome = join(root, 'claude-home')
  const legacyPluginsDir = join(legacyHome, 'plugins')
  const currentPluginsDir = join(root, 'freecode-home', 'plugins')
  mkdirSync(legacyPluginsDir, { recursive: true })
  mkdirSync(currentPluginsDir, { recursive: true })
  return { legacyHome, legacyPluginsDir, currentPluginsDir }
}

describe('remapLegacyHomePluginPath', () => {
  test('remaps when the migrated copy exists at the target', () => {
    const dirs = makeDirs()
    const legacy = join(dirs.legacyPluginsDir, 'marketplaces', 'my-mktpl')
    const target = join(dirs.currentPluginsDir, 'marketplaces', 'my-mktpl')
    mkdirSync(target, { recursive: true })

    expect(remapLegacyHomePluginPath(legacy, dirs)).toBe(target)
  })

  test('remaps when neither path exists (refresh re-materializes at target)', () => {
    const dirs = makeDirs()
    const legacy = join(dirs.legacyPluginsDir, 'marketplaces', 'gone')

    expect(remapLegacyHomePluginPath(legacy, dirs)).toBe(
      join(dirs.currentPluginsDir, 'marketplaces', 'gone'),
    )
  })

  test('keeps a working legacy path when no copy was made', () => {
    const dirs = makeDirs()
    const legacy = join(dirs.legacyPluginsDir, 'marketplaces', 'partial')
    mkdirSync(legacy, { recursive: true })

    expect(remapLegacyHomePluginPath(legacy, dirs)).toBe(legacy)
  })

  test('leaves paths outside the legacy plugins dir untouched', () => {
    const dirs = makeDirs()
    const outside = '/Users/me/projects/my-marketplace'
    expect(remapLegacyHomePluginPath(outside, dirs)).toBe(outside)
    // A sibling file of the plugins dir is not a plugin state path.
    const settings = join(dirs.legacyHome, 'settings.json')
    expect(remapLegacyHomePluginPath(settings, dirs)).toBe(settings)
  })

  test('prefix match respects the directory boundary', () => {
    const dirs = makeDirs()
    // A sibling whose name merely starts with the legacy dir name stays put.
    const lookalike = join(dirs.legacyHome, 'plugins-backup', 'marketplaces')
    expect(remapLegacyHomePluginPath(lookalike, dirs)).toBe(lookalike)
    // Paths inside the dir remap even without an existing copy.
    const inside = join(dirs.legacyPluginsDir, 'marketplaces', 'm')
    expect(remapLegacyHomePluginPath(inside, dirs)).toBe(
      join(dirs.currentPluginsDir, 'marketplaces', 'm'),
    )
  })

  test('no-op when legacy and current plugins dirs are the same', () => {
    const dirs = makeDirs()
    const path = join(dirs.legacyPluginsDir, 'marketplaces', 'm')
    const same = {
      legacyPluginsDir: dirs.legacyPluginsDir,
      currentPluginsDir: dirs.legacyPluginsDir,
    }
    expect(remapLegacyHomePluginPath(path, same)).toBe(path)
  })
})

describe('remapKnownMarketplacesConfigWithDirs', () => {
  test('rewrites installLocation for migrated entries only', () => {
    const dirs = makeDirs()
    const legacy = join(dirs.legacyPluginsDir, 'marketplaces', 'official')
    const target = join(dirs.currentPluginsDir, 'marketplaces', 'official')
    mkdirSync(target, { recursive: true })
    const local = '/home/me/src/my-marketplace'

    const config = {
      official: {
        source: { source: 'github', repo: 'a/b' },
        installLocation: legacy,
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
      local: {
        source: { source: 'directory', path: local },
        installLocation: local,
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    } as const

    const remapped = remapKnownMarketplacesConfigWithDirs(config as never, dirs)
    expect(remapped.official.installLocation).toBe(target)
    expect(remapped.local.installLocation).toBe(local)
  })

  test('returns the same object when nothing needs remapping', () => {
    const dirs = makeDirs()
    const config = {
      local: {
        source: { source: 'directory', path: '/x' },
        installLocation: '/x',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    } as const
    expect(remapKnownMarketplacesConfigWithDirs(config as never, dirs)).toBe(
      config,
    )
  })
})

describe('remapInstalledPluginPaths', () => {
  test('remaps installPath in place when the copy exists', () => {
    const dirs = makeDirs()
    const legacy = join(
      dirs.legacyPluginsDir,
      'cache',
      'official',
      'my-plugin',
      'v1',
    )
    const target = join(
      dirs.currentPluginsDir,
      'cache',
      'official',
      'my-plugin',
      'v1',
    )
    mkdirSync(target, { recursive: true })
    const data = {
      plugins: {
        'my-plugin@official': [{ scope: 'user', installPath: legacy }],
      },
    }

    expect(remapInstalledPluginPaths(data, dirs)).toBe(true)
    expect(data.plugins['my-plugin@official'][0].installPath).toBe(target)
  })
})

describe('rewriteMigratedPluginStatePaths', () => {
  test('rewrites copied state files to the new home', () => {
    const root = makeTempDir('rewrite-migrated-')
    const legacyHome = join(root, 'claude-home')
    const newHome = join(root, 'freecode-home')
    const plugins = join(newHome, 'plugins')
    mkdirSync(join(plugins, 'marketplaces', 'official'), { recursive: true })
    mkdirSync(join(plugins, 'cache', 'official', 'p', 'v1'), {
      recursive: true,
    })

    writeFileSync(
      join(plugins, 'known_marketplaces.json'),
      JSON.stringify({
        official: {
          source: { source: 'github', repo: 'a/b' },
          installLocation: join(
            legacyHome,
            'plugins',
            'marketplaces',
            'official',
          ),
          lastUpdated: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    writeFileSync(
      join(plugins, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'p@official': [
            {
              scope: 'user',
              installPath: join(
                legacyHome,
                'plugins',
                'cache',
                'official',
                'p',
                'v1',
              ),
            },
          ],
        },
      }),
    )

    rewriteMigratedPluginStatePaths(legacyHome, newHome)

    const marketplaces = JSON.parse(
      readFileSync(join(plugins, 'known_marketplaces.json'), 'utf8'),
    )
    expect(marketplaces.official.installLocation).toBe(
      join(newHome, 'plugins', 'marketplaces', 'official'),
    )
    const installed = JSON.parse(
      readFileSync(join(plugins, 'installed_plugins.json'), 'utf8'),
    )
    expect(installed.plugins['p@official'][0].installPath).toBe(
      join(newHome, 'plugins', 'cache', 'official', 'p', 'v1'),
    )
  })
})
