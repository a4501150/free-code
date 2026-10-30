/**
 * Runtime repair for plugin state whose recorded absolute paths still point
 * into the legacy ~/.claude config home.
 *
 * migrateToFreecodeDir() copies ~/.claude/ to ~/.freecode/ verbatim, so
 * known_marketplaces.json entries (installLocation) and installed_plugins.json
 * entries (installPath) keep their legacy-home prefix after migration.
 * refreshMarketplace() rejects any installLocation outside the current
 * marketplaces cache dir, so every refresh of a migrated marketplace failed
 * with "corrupted installLocation". Fix the prefix at load time instead.
 *
 * Safety: a path is only remapped when the copied target exists under the
 * current plugins dir (the migration carried it over), or the legacy path is
 * gone entirely (a later refresh re-materializes it at the target). A
 * still-resolvable legacy path with no copied target is left alone — that is
 * a partial copy, and the legacy location is the only working one.
 */

import { existsSync } from 'fs'
import { join, sep } from 'path'
import { logForDebugging } from '../debug.js'
import { getLegacyClaudeConfigDir } from '../settings/claudeMigration.js'
import { getPluginsDirectory } from './pluginDirectories.js'
import type { KnownMarketplacesFile } from './schemas.js'

export type LegacyHomeRemapDirs = {
  legacyPluginsDir: string
  currentPluginsDir: string
}

/**
 * Remap one recorded path from the legacy plugins dir into the current one.
 * Returns the path unchanged when it is not under the legacy prefix, when the
 * prefix rewrite is a no-op, or when the safety rule above says to leave it.
 */
export function remapLegacyHomePluginPath(
  path: string,
  dirs: LegacyHomeRemapDirs,
): string {
  const prefix = dirs.legacyPluginsDir + sep
  if (!path.startsWith(prefix)) {
    return path
  }
  const candidate = join(dirs.currentPluginsDir, path.slice(prefix.length))
  if (candidate === path) {
    return path
  }
  if (existsSync(candidate) || !existsSync(path)) {
    return candidate
  }
  return path
}

/** Runtime dirs: legacy ~/.claude/plugins → whatever getPluginsDirectory() resolves to now. */
function runtimeRemapDirs(): LegacyHomeRemapDirs {
  return {
    legacyPluginsDir: join(getLegacyClaudeConfigDir(), 'plugins'),
    currentPluginsDir: getPluginsDirectory(),
  }
}

export function remapKnownMarketplacesConfigWithDirs(
  config: KnownMarketplacesFile,
  dirs: LegacyHomeRemapDirs,
): KnownMarketplacesFile {
  let changed = false
  const out: KnownMarketplacesFile = {}
  for (const [name, entry] of Object.entries(config)) {
    const location = entry?.installLocation
    if (typeof location === 'string') {
      const remapped = remapLegacyHomePluginPath(location, dirs)
      if (remapped !== location) {
        changed = true
        logForDebugging(
          `Remapped legacy-home installLocation for marketplace '${name}': ` +
            `${location} -> ${remapped}`,
        )
        out[name] = { ...entry, installLocation: remapped }
        continue
      }
    }
    out[name] = entry
  }
  return changed ? out : config
}

export function remapKnownMarketplacesConfig(
  config: KnownMarketplacesFile,
): KnownMarketplacesFile {
  return remapKnownMarketplacesConfigWithDirs(config, runtimeRemapDirs())
}

/**
 * In-place remap of installPath fields in a V2 installed_plugins structure.
 * Entries whose installPath stays legacy keep working from the legacy dir.
 */
export function remapInstalledPluginPaths(
  data: { plugins: Record<string, Array<{ installPath?: unknown }>> },
  dirs?: LegacyHomeRemapDirs,
): boolean {
  const effectiveDirs = dirs ?? runtimeRemapDirs()
  let changed = false
  for (const entries of Object.values(data.plugins)) {
    for (const entry of entries) {
      const installPath = entry.installPath
      if (typeof installPath !== 'string') {
        continue
      }
      const remapped = remapLegacyHomePluginPath(installPath, effectiveDirs)
      if (remapped !== installPath) {
        changed = true
        logForDebugging(
          `Remapped legacy-home installPath: ${installPath} -> ${remapped}`,
        )
        entry.installPath = remapped
      }
    }
  }
  return changed
}
