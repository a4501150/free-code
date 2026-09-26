/**
 * Perfetto Tracing for Claude Code (Ant-only)
 *
 * This module generates traces in the Chrome Trace Event format that can be
 * viewed in ui.perfetto.dev or Chrome's chrome://tracing.
 *
 * NOTE: This feature is ant-only and eliminated from external builds.
 *
 * The trace file includes:
 * - Agent hierarchy (parent-child spawn relationships)
 * - API requests with TTFT, TTLT, prompt length, cache stats, msg ID, speculative flag
 * - Tool executions with name, duration, and token usage
 * - User input waiting time
 *
 * Usage:
 * 1. Enable via CLAUDE_CODE_PERFETTO_TRACE=1 or CLAUDE_CODE_PERFETTO_TRACE=<path>
 * 2. Optionally set CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S=<positive integer> to write the
 *    trace file periodically (default: write only on exit).
 * 3. Run Claude Code normally
 * 4. Trace file is written to ~/.freecode/traces/trace-<session-id>.json
 *    or to the specified path
 * 5. Open in ui.perfetto.dev to visualize
 */

import { feature } from 'bun:bundle'
import { mkdirSync, writeFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { djb2Hash } from '../hash.js'
import { jsonStringify } from '../slowOperations.js'
import { getAgentContext } from '../agentContext.js'

/**
 * Chrome Trace Event format types
 * See: https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 */

export type TraceEventPhase =
  | 'B' // Begin duration event
  | 'E' // End duration event
  | 'X' // Complete event (with duration)
  | 'i' // Instant event
  | 'C' // Counter event
  | 'b' // Async begin
  | 'n' // Async instant
  | 'e' // Async end
  | 'M' // Metadata event

export type TraceEvent = {
  name: string
  cat: string
  ph: TraceEventPhase
  ts: number // Timestamp in microseconds
  pid: number // Process ID (we use 1 for main, agent IDs for subagents)
  tid: number // Thread ID (we use numeric hash of agent name or 1 for main)
  dur?: number // Duration in microseconds (for 'X' events)
  args?: Record<string, unknown>
  id?: string // For async events
  scope?: string
}

/**
 * Agent info for tracking hierarchy
 */
type AgentInfo = {
  agentId: string
  agentName: string
  parentAgentId?: string
  processId: number
  threadId: number
}

/**
 * Pending span for tracking begin/end pairs
 */
type PendingSpan = {
  name: string
  category: string
  startTime: number
  agentInfo: AgentInfo
  args: Record<string, unknown>
}

// Global state for the Perfetto tracer
let isEnabled = false
let tracePath: string | null = null
// Metadata events (ph: 'M' — process/thread names, parent links) are kept
// separate so they survive eviction — Perfetto UI needs them to label
// tracks. Bounded by agent count (~3 events per agent).
const metadataEvents: TraceEvent[] = []
const events: TraceEvent[] = []
// events[] cap. Cron-driven sessions run for days; 22 push sites × many
// turns would otherwise grow unboundedly (periodicWrite flushes to disk but
// does not truncate — it writes the full snapshot). At ~300B/event this is
// ~30MB, enough trace history for any debugging session. Eviction drops the
// oldest half when hit, amortized O(1).
const MAX_EVENTS = 100_000
const pendingSpans = new Map<string, PendingSpan>()
const agentRegistry = new Map<string, AgentInfo>()
let totalAgentCount = 0
let startTimeMs = 0
let spanIdCounter = 0
let traceWritten = false // Flag to avoid double writes

// Map agent IDs to numeric process IDs (Perfetto requires numeric IDs)
let processIdCounter = 1
const agentIdToProcessId = new Map<string, number>()

// Periodic write interval handle
let writeIntervalId: ReturnType<typeof setInterval> | null = null

const STALE_SPAN_TTL_MS = 30 * 60 * 1000 // 30 minutes
const STALE_SPAN_CLEANUP_INTERVAL_MS = 60 * 1000 // 1 minute
let staleSpanCleanupId: ReturnType<typeof setInterval> | null = null

/**
 * Convert a string to a numeric hash for use as thread ID
 */
function stringToNumericHash(str: string): number {
  return Math.abs(djb2Hash(str)) || 1 // Ensure non-zero
}

/**
 * Get or create a numeric process ID for an agent
 */
function getProcessIdForAgent(agentId: string): number {
  const existing = agentIdToProcessId.get(agentId)
  if (existing !== undefined) return existing

  processIdCounter++
  agentIdToProcessId.set(agentId, processIdCounter)
  return processIdCounter
}

/**
 * Get current agent info
 */
function getCurrentAgentInfo(): AgentInfo {
  const ctx = getAgentContext()
  const agentId = ctx?.agentId ?? getSessionId()
  const agentName = ctx?.subagentName ?? 'main'

  // Check if we've already registered this agent
  const existing = agentRegistry.get(agentId)
  if (existing) return existing

  const info: AgentInfo = {
    agentId,
    agentName,
    processId: agentId === getSessionId() ? 1 : getProcessIdForAgent(agentId),
    threadId: stringToNumericHash(agentName),
  }

  agentRegistry.set(agentId, info)
  totalAgentCount++
  return info
}

/**
 * Get timestamp in microseconds relative to trace start
 */
function getTimestamp(): number {
  return (Date.now() - startTimeMs) * 1000
}

/**
 * Generate a unique span ID
 */
function generateSpanId(): string {
  return `span_${++spanIdCounter}`
}

/**
 * Evict pending spans older than STALE_SPAN_TTL_MS.
 * Mirrors the TTL cleanup pattern in sessionTracing.ts.
 */
function evictStaleSpans(): void {
  const now = getTimestamp()
  const ttlUs = STALE_SPAN_TTL_MS * 1000 // Convert ms to microseconds
  for (const [spanId, span] of pendingSpans) {
    if (now - span.startTime > ttlUs) {
      // Emit an end event so the span shows up in the trace as incomplete
      events.push({
        name: span.name,
        cat: span.category,
        ph: 'E',
        ts: now,
        pid: span.agentInfo.processId,
        tid: span.agentInfo.threadId,
        args: {
          ...span.args,
          evicted: true,
          duration_ms: (now - span.startTime) / 1000,
        },
      })
      pendingSpans.delete(spanId)
    }
  }
}

/**
 * Build the full trace document (Chrome Trace JSON format).
 */
function buildTraceDocument(): string {
  return jsonStringify({
    traceEvents: [...metadataEvents, ...events],
    metadata: {
      session_id: getSessionId(),
      trace_start_time: new Date(startTimeMs).toISOString(),
      agent_count: totalAgentCount,
      total_event_count: metadataEvents.length + events.length,
    },
  })
}

/**
 * Drop the oldest half of events[] when over MAX_EVENTS. Called from the
 * stale-span cleanup interval (60s). The half-batch splice keeps this
 * amortized O(1) — we don't pay splice cost per-push. A synthetic marker
 * is inserted so the gap is visible in ui.perfetto.dev.
 */
function evictOldestEvents(): void {
  if (events.length < MAX_EVENTS) return
  const dropped = events.splice(0, MAX_EVENTS / 2)
  events.unshift({
    name: 'trace_truncated',
    cat: '__metadata',
    ph: 'i',
    ts: dropped[dropped.length - 1]?.ts ?? 0,
    pid: 1,
    tid: 0,
    args: { dropped_events: dropped.length },
  })
  logForDebugging(
    `[Perfetto] Evicted ${dropped.length} oldest events (cap ${MAX_EVENTS})`,
  )
}

/**
 * Emit metadata events for a process/agent
 */
function emitProcessMetadata(agentInfo: AgentInfo): void {
  if (!isEnabled) return

  // Process name
  metadataEvents.push({
    name: 'process_name',
    cat: '__metadata',
    ph: 'M',
    ts: 0,
    pid: agentInfo.processId,
    tid: 0,
    args: { name: agentInfo.agentName },
  })

  // Thread name (same as process for now)
  metadataEvents.push({
    name: 'thread_name',
    cat: '__metadata',
    ph: 'M',
    ts: 0,
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args: { name: agentInfo.agentName },
  })

  // Add parent info if available
  if (agentInfo.parentAgentId) {
    metadataEvents.push({
      name: 'parent_agent',
      cat: '__metadata',
      ph: 'M',
      ts: 0,
      pid: agentInfo.processId,
      tid: 0,
      args: {
        parent_agent_id: agentInfo.parentAgentId,
      },
    })
  }
}

/**
 * Check if Perfetto tracing is enabled
 */
export function isPerfettoTracingEnabled(): boolean {
  return isEnabled
}

/**
 * Register a new agent in the trace
 * Call this when a subagent is spawned
 */
export function registerAgent(
  agentId: string,
  agentName: string,
  parentAgentId?: string,
): void {
  if (!isEnabled) return

  const info: AgentInfo = {
    agentId,
    agentName,
    parentAgentId,
    processId: getProcessIdForAgent(agentId),
    threadId: stringToNumericHash(agentName),
  }

  agentRegistry.set(agentId, info)
  totalAgentCount++
  emitProcessMetadata(info)
}

/**
 * Unregister an agent from the trace.
 * Call this when an agent completes, fails, or is aborted to free memory.
 */
export function unregisterAgent(agentId: string): void {
  if (!isEnabled) return
  agentRegistry.delete(agentId)
  agentIdToProcessId.delete(agentId)
}

// ---------------------------------------------------------------------------
// Periodic write helpers
// ---------------------------------------------------------------------------

/**
 * Stop the periodic write timer.
 */
function stopWriteInterval(): void {
  if (staleSpanCleanupId) {
    clearInterval(staleSpanCleanupId)
    staleSpanCleanupId = null
  }
  if (writeIntervalId) {
    clearInterval(writeIntervalId)
    writeIntervalId = null
  }
}

/**
 * Force-close any remaining open spans at session end.
 */
function closeOpenSpans(): void {
  for (const [spanId, pending] of pendingSpans) {
    const endTime = getTimestamp()
    events.push({
      name: pending.name,
      cat: pending.category,
      ph: 'E',
      ts: endTime,
      pid: pending.agentInfo.processId,
      tid: pending.agentInfo.threadId,
      args: {
        ...pending.args,
        incomplete: true,
        duration_ms: (endTime - pending.startTime) / 1000,
      },
    })
    pendingSpans.delete(spanId)
  }
}

/**
 * Write the full trace to disk.  Errors are logged but swallowed so that a
 * transient I/O problem does not crash the session — the next periodic tick
 * (or the final exit write) will retry with a complete snapshot.
 */
async function periodicWrite(): Promise<void> {
  if (!isEnabled || !tracePath || traceWritten) return

  try {
    await mkdir(dirname(tracePath), { recursive: true })
    await writeFile(tracePath, buildTraceDocument())
    logForDebugging(
      `[Perfetto] Periodic write: ${events.length} events to ${tracePath}`,
    )
  } catch (error) {
    logForDebugging(
      `[Perfetto] Periodic write failed: ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
}

/**
 * Final async write: close open spans and write the complete trace.
 * Idempotent — sets `traceWritten` on success so subsequent calls are no-ops.
 */
async function writePerfettoTrace(): Promise<void> {
  if (!isEnabled || !tracePath || traceWritten) {
    logForDebugging(
      `[Perfetto] Skipping final write: isEnabled=${isEnabled}, tracePath=${tracePath}, traceWritten=${traceWritten}`,
    )
    return
  }

  stopWriteInterval()
  closeOpenSpans()

  logForDebugging(
    `[Perfetto] writePerfettoTrace called: events=${events.length}`,
  )

  try {
    await mkdir(dirname(tracePath), { recursive: true })
    await writeFile(tracePath, buildTraceDocument())
    traceWritten = true
    logForDebugging(`[Perfetto] Trace finalized at: ${tracePath}`)
  } catch (error) {
    logForDebugging(
      `[Perfetto] Failed to write final trace: ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
}

/**
 * Final synchronous write (fallback for process 'exit' handler where async is forbidden).
 */
function writePerfettoTraceSync(): void {
  if (!isEnabled || !tracePath || traceWritten) {
    logForDebugging(
      `[Perfetto] Skipping final sync write: isEnabled=${isEnabled}, tracePath=${tracePath}, traceWritten=${traceWritten}`,
    )
    return
  }

  stopWriteInterval()
  closeOpenSpans()

  logForDebugging(
    `[Perfetto] writePerfettoTraceSync called: events=${events.length}`,
  )

  try {
    const dir = dirname(tracePath)
    // eslint-disable-next-line custom-rules/no-sync-fs -- Only called from process.on('exit') handler
    mkdirSync(dir, { recursive: true })
    // eslint-disable-next-line custom-rules/no-sync-fs, eslint-plugin-n/no-sync -- Required for process 'exit' handler which doesn't support async
    writeFileSync(tracePath, buildTraceDocument())
    traceWritten = true
    logForDebugging(`[Perfetto] Trace finalized synchronously at: ${tracePath}`)
  } catch (error) {
    logForDebugging(
      `[Perfetto] Failed to write final trace synchronously: ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
}
