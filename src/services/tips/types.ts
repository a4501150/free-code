import type { ThemeName } from 'src/utils/theme.js'
import type { FileStateCache } from 'src/utils/fileStateCache.js'

/**
 * Context passed to a Tip's relevance check, carrying lightweight signals
 * about what the user has been doing in the current session. Populated by
 * the spinner code before asking getRelevantTips(). Consumer: the
 * tips in src/services/tips/tipRegistry.ts read only the fields below.
 */
export type TipContext = {
  /** Bash commands the user has invoked this session (by first token). */
  bashTools?: Set<string>
  /** Cache of files the user has read, keyed by absolute path. */
  readFileState?: FileStateCache
}

/**
 * Context passed to a Tip's content renderer so the tip can style output
 * (e.g. pick the right suggestion/link color for the active theme).
 */
export type TipRenderContext = {
  theme: ThemeName
}

/**
 * A single dismissible tip shown while the spinner is active. See
 * src/services/tips/tipRegistry.ts for examples.
 */
export type Tip = {
  /** Stable identifier, used for history / cooldown bookkeeping. */
  id: string
  /** Produces the rendered tip text. Async to allow lazy data lookups. */
  content: (ctx: TipRenderContext) => Promise<string>
  /**
   * Minimum number of sessions between successive displays. Enforced in
   * getRelevantTips by consulting tipHistory.
   */
  cooldownSessions: number
  /**
   * Returns whether the tip is applicable in the given context.
   * Context is undefined when the spinner fires outside a turn.
   */
  isRelevant: (context?: TipContext) => Promise<boolean>
}
