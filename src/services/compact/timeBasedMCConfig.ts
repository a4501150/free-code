import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Config for time-based microcompact.
 *
 * Triggers content-clearing microcompact when the gap since the last main-loop
 * assistant message exceeds a threshold. The clearing is only free where the
 * server-side prompt cache EXPIRES ON IDLE: Anthropic-family providers evict
 * after their TTL, so the full prefix is rewritten on return anyway and
 * clearing old tool results first shrinks that rewrite. Providers with
 * automatic-prefix caches (OpenAI-compatible endpoints, local servers) keep a
 * warm prefix until memory-pressure eviction, so a clear there costs a real
 * cache miss from the first cleared block onward — that is why the gate in
 * evaluateTimeBasedTrigger skips them unless clearOnAutomaticPrefixCache says
 * otherwise.
 *
 * Runs BEFORE the API call (in microcompactMessages, upstream of callModel)
 * so the shrunk prompt is what actually gets sent. Running after the first
 * miss would only help subsequent turns.
 *
 * Main thread only — subagents have short lifetimes where gap-based eviction
 * doesn't apply.
 */
export type TimeBasedMCConfig = {
  /** Master switch. When false, time-based microcompact is a no-op. */
  enabled: boolean
  /** Trigger when (now − last assistant timestamp) exceeds this many minutes.
   *  60 is the safe choice: the server's 1h cache TTL is guaranteed expired
   *  for all users, so we never force a miss that wouldn't have happened. */
  gapThresholdMinutes: number
  /** Keep this many most-recent compactable tool results.
   *  When set, takes priority over any default; older results are cleared. */
  keepRecent: number
  /** Clear old results even when the provider caches prefixes
   *  automatically (local servers, OpenAI-compatible endpoints). The gap
   *  premise "cache already expired" does not hold there — set this only
   *  when you prefer a smaller prompt over a warm prefix on return. */
  clearOnAutomaticPrefixCache?: boolean
}

const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
  clearOnAutomaticPrefixCache: false,
}

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  return (
    getInitialSettings()?.timeBasedMicrocompactConfig ??
    TIME_BASED_MC_CONFIG_DEFAULTS
  )
}
