import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { feature } from 'bun:bundle'

const __filename = fileURLToPath(import.meta.url)
const sourceVendorSearchToolsRoot = resolve(
  dirname(__filename),
  '../../vendor/search-tools',
)

type BundledSearchToolPaths = {
  bfsPath: string
  ugrepPath: string
}

function getSearchToolsPlatformDir(): string {
  return `${process.arch}-${process.platform}`
}

function getSearchToolBinaryName(name: 'bfs' | 'ugrep'): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

export function bundledSearchToolPaths(): BundledSearchToolPaths | null {
  const platformDir = getSearchToolsPlatformDir()
  const candidateRoots = [
    resolve(dirname(process.execPath), 'vendor/search-tools'),
    sourceVendorSearchToolsRoot,
  ]

  for (const root of candidateRoots) {
    const dir = resolve(root, platformDir)
    const bfsPath = resolve(dir, getSearchToolBinaryName('bfs'))
    const ugrepPath = resolve(dir, getSearchToolBinaryName('ugrep'))
    if (existsSync(bfsPath) && existsSync(ugrepPath)) {
      return { bfsPath, ugrepPath }
    }
  }

  return null
}

function isSearchToolEntrypointEnabled(): boolean {
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * Whether this build has vendored bfs/ugrep available for Bash search wrappers.
 *
 * When true:
 * - `find` and `grep` in Claude's Bash shell are shadowed by shell functions
 *   that invoke vendored bfs/ugrep binaries
 * - The dedicated Glob/Grep tools are removed from the tool registry
 * - Prompt guidance steering Claude away from find/grep is omitted
 */
export function hasEmbeddedSearchTools(): boolean {
  return isSearchToolEntrypointEnabled() && bundledSearchToolPaths() !== null
}

/**
 * True when Glob/Grep should be omitted and the model should prefer
 * `find` / `grep` / `rg` via the Bash tool. Distinct from
 * hasEmbeddedSearchTools(), which specifically reports whether the
 * runtime has bfs/ugrep available (a perf concern).
 *
 * Gated by the `DEDICATED_SEARCH_TOOLS` feature flag — default builds
 * strip Glob/Grep and use bash-first prompt variants. Opt in at build
 * time with `--feature=DEDICATED_SEARCH_TOOLS` to restore them.
 */
export function shouldPreferBashForSearch(): boolean {
  if (feature('DEDICATED_SEARCH_TOOLS')) return hasEmbeddedSearchTools()
  return true
}
