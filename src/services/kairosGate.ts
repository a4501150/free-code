/**
 * KAIROS feature gate.
 *
 * In the upstream Anthropic build, this checks a server-side feature gate
 * (GrowthBook tengu_kairos). In this fork, the build-time feature('KAIROS')
 * flag is the real gate — this always returns true when called.
 */

/**
 * Check if KAIROS is enabled for the current user/session.
 * Always returns true in this fork — gating is done at build time.
 */
export async function isKairosEnabled(): Promise<boolean> {
  return true
}
