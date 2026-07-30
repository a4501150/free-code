import isEqual from 'lodash-es/isEqual.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import { plural } from '../stringUtils.js'
import { checkGitAvailable } from './gitAvailability.js'
import { getMarketplace } from './marketplaceManager.js'
import type { KnownMarketplace, MarketplaceSource } from './schemas.js'

/**
 * Format plugin failure details for user display
 * @param failures - Array of failures with names and reasons
 * @param includeReasons - Whether to include failure reasons (true for full errors, false for summaries)
 * @returns Formatted string like "plugin-a (reason); plugin-b (reason)" or "plugin-a, plugin-b"
 */
export function formatFailureDetails(
  failures: Array<{ name: string; reason?: string; error?: string }>,
  includeReasons: boolean,
): string {
  const maxShow = 2
  const details = failures
    .slice(0, maxShow)
    .map(f => {
      const reason = f.reason || f.error || 'unknown error'
      return includeReasons ? `${f.name} (${reason})` : f.name
    })
    .join(includeReasons ? '; ' : ', ')

  const remaining = failures.length - maxShow
  const moreText = remaining > 0 ? ` and ${remaining} more` : ''

  return `${details}${moreText}`
}

/**
 * Extract source display string from marketplace configuration
 */
export function getMarketplaceSourceDisplay(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return source.repo
    case 'url':
      return source.url
    case 'git':
      return source.url
    case 'directory':
      return source.path
    case 'file':
      return source.path
    case 'settings':
      return `settings:${source.name}`
    default:
      return 'Unknown source'
  }
}

/**
 * Create a plugin ID from plugin name and marketplace name
 */
export function createPluginId(
  pluginName: string,
  marketplaceName: string,
): string {
  return `${pluginName}@${marketplaceName}`
}

/**
 * Load marketplaces with graceful degradation for individual failures.
 * Blocked marketplaces (per enterprise policy) are excluded from the results.
 */
export async function loadMarketplacesWithGracefulDegradation(
  config: Record<string, KnownMarketplace>,
): Promise<{
  marketplaces: Array<{
    name: string
    config: KnownMarketplace
    data: Awaited<ReturnType<typeof getMarketplace>> | null
  }>
  failures: Array<{ name: string; error: string }>
}> {
  const marketplaces: Array<{
    name: string
    config: KnownMarketplace
    data: Awaited<ReturnType<typeof getMarketplace>> | null
  }> = []
  const failures: Array<{ name: string; error: string }> = []

  for (const [name, marketplaceConfig] of Object.entries(config)) {
    let data = null
    try {
      data = await getMarketplace(name)
    } catch (err) {
      // Track individual marketplace failures but continue loading others
      const errorMessage = err instanceof Error ? err.message : String(err)
      failures.push({ name, error: errorMessage })

      // Log for monitoring
      logError(toError(err))
    }

    marketplaces.push({
      name,
      config: marketplaceConfig,
      data,
    })
  }

  return { marketplaces, failures }
}

/**
 * Format marketplace loading failures into appropriate user messages
 */
export function formatMarketplaceLoadingErrors(
  failures: Array<{ name: string; error: string }>,
  successCount: number,
): { type: 'warning' | 'error'; message: string } | null {
  if (failures.length === 0) {
    return null
  }

  // If some marketplaces succeeded, show warning
  if (successCount > 0) {
    const message =
      failures.length === 1
        ? `Warning: Failed to load marketplace '${failures[0]!.name}': ${failures[0]!.error}`
        : `Warning: Failed to load ${failures.length} marketplaces: ${formatFailureNames(failures)}`
    return { type: 'warning', message }
  }

  // All marketplaces failed - this is a critical error
  return {
    type: 'error',
    message: `Failed to load all marketplaces. Errors: ${formatFailureErrors(failures)}`,
  }
}

function formatFailureNames(
  failures: Array<{ name: string; error: string }>,
): string {
  return failures.map(f => f.name).join(', ')
}

function formatFailureErrors(
  failures: Array<{ name: string; error: string }>,
): string {
  return failures.map(f => `${f.name}: ${f.error}`).join('; ')
}

/**
 * Format a MarketplaceSource for display in error messages
 */
export function formatSourceForDisplay(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return `github:${source.repo}${source.ref ? `@${source.ref}` : ''}`
    case 'url':
      return source.url
    case 'git':
      return `git:${source.url}${source.ref ? `@${source.ref}` : ''}`
    case 'npm':
      return `npm:${source.package}`
    case 'file':
      return `file:${source.path}`
    case 'directory':
      return `dir:${source.path}`
    case 'settings':
      return `settings:${source.name} (${source.plugins.length} ${plural(source.plugins.length, 'plugin')})`
    default:
      return 'unknown source'
  }
}

/**
 * Reasons why no marketplaces are available in the Discover screen
 */
export type EmptyMarketplaceReason =
  | 'git-not-installed'
  | 'all-marketplaces-failed'
  | 'no-marketplaces-configured'
  | 'all-plugins-installed'

/**
 * Detect why no marketplaces are available.
 * Checks in order of priority: git availability → config state → failures
 */
export async function detectEmptyMarketplaceReason({
  configuredMarketplaceCount,
  failedMarketplaceCount,
}: {
  configuredMarketplaceCount: number
  failedMarketplaceCount: number
}): Promise<EmptyMarketplaceReason> {
  // Check if git is installed (required for most marketplace sources)
  const gitAvailable = await checkGitAvailable()
  if (!gitAvailable) {
    return 'git-not-installed'
  }

  // Check if any marketplaces are configured
  if (configuredMarketplaceCount === 0) {
    return 'no-marketplaces-configured'
  }

  // Check if all configured marketplaces failed to load
  if (
    failedMarketplaceCount > 0 &&
    failedMarketplaceCount === configuredMarketplaceCount
  ) {
    return 'all-marketplaces-failed'
  }

  // Marketplaces are configured and loaded, but no plugins available
  // This typically means all plugins are already installed
  return 'all-plugins-installed'
}
