import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

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

// Memoized: runs existsSync on the per-request Bash tool-prompt build path.
// Binary locations are immutable for a process.
export const bundledSearchToolPaths = memoize(
  (): BundledSearchToolPaths | null => {
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
  },
)

function isSearchToolEntrypointEnabled(): boolean {
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * Whether this build has vendored bfs/ugrep available for Bash search wrappers.
 *
 * When true, `find` and `grep` in the Bash shell are shadowed by shell
 * functions that invoke the vendored bfs/ugrep binaries (see
 * ShellSnapshot.ts). Whether they're available is a perf concern only —
 * search itself always goes through the Bash channel either way, falling
 * back to the system `find`/`grep`/`rg` when the sidecars are absent.
 */
export function hasEmbeddedSearchTools(): boolean {
  return isSearchToolEntrypointEnabled() && bundledSearchToolPaths() !== null
}
