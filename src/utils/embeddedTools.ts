import { feature } from 'bun:bundle'
import { isEnvTruthy } from './envUtils.js'

/**
 * Whether this build has bfs/ugrep embedded in the bun binary (ant-native only).
 *
 * When true:
 * - `find` and `grep` in Claude's Bash shell are shadowed by shell functions
 *   that invoke the bun binary with argv0='bfs' / argv0='ugrep' (same trick
 *   as embedded ripgrep)
 * - The dedicated Glob/Grep tools are removed from the tool registry
 * - Prompt guidance steering Claude away from find/grep is omitted
 *
 * Set as a build-time define in scripts/build-with-plugins.ts for ant-native builds.
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * True when Glob/Grep should be omitted and the model should prefer
 * `find` / `grep` / `rg` via the Bash tool. Distinct from
 * hasEmbeddedSearchTools(), which specifically reports whether the
 * bun binary has the bfs/ugrep fallbacks baked in (a perf concern).
 *
 * Gated by the `DEDICATED_SEARCH_TOOLS` feature flag — default builds
 * strip Glob/Grep and use bash-first prompt variants. Opt in at build
 * time with `--feature=DEDICATED_SEARCH_TOOLS` to restore them.
 */
export function shouldPreferBashForSearch(): boolean {
  if (feature('DEDICATED_SEARCH_TOOLS')) return hasEmbeddedSearchTools()
  return true
}

/**
 * Path to the bun binary that contains the embedded search tools.
 * Only meaningful when hasEmbeddedSearchTools() is true.
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
