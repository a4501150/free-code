// Session-level prompt-cache observability for the /usage tab.
//
// The summary is computed from the conversation transcript rather than a live
// tracker: every assistant record already persists normalized usage
// (cache_read_input_tokens / cache_creation_input_tokens) because every
// adapter maps its provider's cache reporting onto those fields — Anthropic's
// usage fields, OpenAI's prompt_tokens_details.cached_tokens, Gemini's
// cachedContentTokenCount. That makes the cache row work for all providers
// whose APIs report cache tokens, and it survives resume for free. Cause
// attribution is the one piece that cannot be derived from usage numbers, so
// promptCacheBreakDetection feeds confirmed breaks into the small live store
// below; after a resume the row degrades to no-cause instead of lying.

import type { Message } from 'src/types/message.js'
import { formatDuration, formatNumber } from 'src/utils/format.js'
import { getProviderRegistry } from 'src/utils/model/providerRegistry.js'
import type { ProviderCacheType } from 'src/utils/settings/types.js'

export type PromptCacheSummary = {
  requests: number
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Share of prompt-side input served from cache: reads / (input + reads + writes). */
  hitRatio: number | null
  misses: number
  lastMissAt: number | null
  /** Cache-creation tokens billed on miss requests (the re-cache cost). */
  missRecacheTokens: number
  /** Cache drops explained by compaction or tool-result clearing, not counted as misses. */
  expectedRebuilds: number
  /** Any response reported non-zero cache tokens. */
  cachingObserved: boolean
  lastActivityAt: number
  /** Idle-expiry tiers (minutes, ascending) the provider declares; [] = undocumented. */
  idleTtlMinutes: number[]
  cacheType: ProviderCacheType
  /** Causes for the last miss; only available live, empty after resume. */
  lastMissCauses: string[]
}

// Keep the miss thresholds byte-identical with promptCacheBreakDetection so
// the transcript walk and the live detector agree on what a miss is.
const MIN_CACHE_MISS_TOKENS = 2_000
const MISS_RATIO = 0.95

// ── Live attribution overlay (filled by promptCacheBreakDetection) ─────

type ObservedBreak = { atMs: number; causes: string[] }
const recentBreaks: ObservedBreak[] = []
const MAX_TRACKED_BREAKS = 20

/** Called when the break detector confirms a main-thread cache break. */
export function recordMainCacheBreak(atMs: number, reason: string): void {
  recentBreaks.push({ atMs, causes: reason.split(', ') })
  if (recentBreaks.length > MAX_TRACKED_BREAKS) recentBreaks.shift()
}

export function resetPromptCacheStats(): void {
  recentBreaks.length = 0
}

function causesNear(atMs: number): string[] {
  // Breaks are confirmed milliseconds after the response lands, but allow a
  // generous window so clock skew between message timestamp and confirmation
  // does not drop the attribution.
  for (let i = recentBreaks.length - 1; i >= 0; i--) {
    const b = recentBreaks[i]!
    if (Math.abs(b.atMs - atMs) <= 120_000) return b.causes
  }
  return []
}

// ── Summary computation ────────────────────────────────────────────────

export function computePromptCacheSummary(
  messages: Message[],
  now: number = Date.now(),
): PromptCacheSummary | null {
  let requests = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let misses = 0
  let lastMissAt: number | null = null
  let missRecacheTokens = 0
  let expectedRebuilds = 0
  let cachingObserved = false
  let lastActivityAt: number | null = null
  let lastModel: string | null = null
  // Baseline for the drop heuristic; null resets it (first request, or a
  // compaction boundary legitimately lowered the cached prefix).
  let prevCacheRead: number | null = null

  for (const m of messages) {
    if (m.type === 'system') {
      if (
        m.subtype === 'compact_boundary' ||
        m.subtype === 'microcompact_boundary'
      ) {
        expectedRebuilds++
        prevCacheRead = null
      }
      continue
    }
    if (m.type !== 'assistant' || m.isSidechain || m.isApiErrorMessage) {
      continue
    }
    const usage = m.message?.usage
    if (!usage) continue
    const atMs = new Date(m.timestamp).getTime()
    lastModel = m.message.model ?? lastModel

    const input = usage.input_tokens ?? 0
    const read = usage.cache_read_input_tokens ?? 0
    const creation = usage.cache_creation_input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    // Post-compaction records are persisted with zeroed usage — they are
    // placeholders, not requests.
    if (input + read + creation + output === 0) continue

    requests++
    lastActivityAt = atMs
    inputTokens += input
    cacheReadTokens += read
    cacheCreationTokens += creation
    if (read > 0 || creation > 0) cachingObserved = true

    if (
      prevCacheRead !== null &&
      prevCacheRead > 0 &&
      read < prevCacheRead * MISS_RATIO &&
      prevCacheRead - read >= MIN_CACHE_MISS_TOKENS
    ) {
      misses++
      lastMissAt = atMs
      missRecacheTokens += creation
    }
    prevCacheRead = read
  }

  if (requests === 0 || lastActivityAt === null) return null

  const cacheType = lastModel
    ? getProviderRegistry().getProviderCacheType(lastModel)
    : 'explicit-breakpoint'
  const idleTtlMinutes = lastModel
    ? getProviderRegistry().getProviderCacheIdleTtlMinutes(lastModel)
    : []
  const promptSide = inputTokens + cacheReadTokens + cacheCreationTokens
  return {
    requests,
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    hitRatio: promptSide > 0 ? cacheReadTokens / promptSide : null,
    misses,
    lastMissAt,
    missRecacheTokens,
    expectedRebuilds,
    cachingObserved,
    lastActivityAt,
    idleTtlMinutes,
    cacheType,
    lastMissCauses: lastMissAt === null ? [] : causesNear(lastMissAt),
  }
}

// ── Rendering ──────────────────────────────────────────────────────────

function tierLabel(min: number): string {
  return min >= 60 && min % 60 === 0 ? `${min / 60}h` : `${min}min`
}

/**
 * One-line status for the usage tab, styled after the /cost block:
 * "Prompt cache:   12 requests · 68% of input tokens from cache · …".
 * `label` is the row prefix — the usage tab passes "Prompt cache" inside a
 * model block; callers summarizing the whole main thread pass
 * "Prompt cache (main)". Returns null when the row would say nothing (no
 * requests yet, or a provider that declares no caching at all).
 */
export function formatPromptCacheLine(
  s: PromptCacheSummary,
  now: number = Date.now(),
  label = 'Prompt cache',
): string | null {
  if (s.cacheType === 'none') return null
  const parts: string[] = [
    `${s.requests} ${s.requests === 1 ? 'request' : 'requests'}`,
  ]
  if (s.hitRatio !== null) {
    parts.push(`${Math.round(s.hitRatio * 100)}% of input tokens from cache`)
  }
  if (s.misses === 0) {
    parts.push('no misses')
  } else {
    const causeSuffix =
      s.lastMissCauses.length > 0
        ? ` — likely cause: ${s.lastMissCauses.join(', ')}`
        : ''
    parts.push(
      `${s.misses} ${s.misses === 1 ? 'miss' : 'misses'} (last ${
        s.lastMissAt === null ? 'unknown' : formatDuration(now - s.lastMissAt)
      } ago${causeSuffix}, ${formatNumber(s.missRecacheTokens)} tokens re-cached)`,
    )
  }
  if (s.expectedRebuilds > 0) {
    parts.push(
      `${s.expectedRebuilds} expected ${
        s.expectedRebuilds === 1 ? 'rebuild' : 'rebuilds'
      } (compaction or tool-result clearing)`,
    )
  }
  const idleMs = now - s.lastActivityAt
  if (!s.cachingObserved) {
    parts.push('no prompt caching reported by the API')
  } else if (s.idleTtlMinutes.length > 0) {
    // The smallest declared tier is the lifetime our writes get; the larger
    // tiers (1h scopes) require markers we do not currently send.
    const ttl = Math.min(...s.idleTtlMinutes)
    parts.push(
      idleMs <= ttl * 60_000
        ? `warm (${tierLabel(ttl)} TTL, last activity ${formatDuration(idleMs)} ago)`
        : `cold — idle ${formatDuration(idleMs)}`,
    )
  } else {
    // Automatic-prefix providers (OpenAI/Gemini-style) cache and evict on
    // their own schedule; report activity without inventing a TTL.
    parts.push(
      `cache lifetime set by provider (last activity ${formatDuration(idleMs)} ago)`,
    )
  }
  return `${label}:   ${parts.join(' · ')}`
}
