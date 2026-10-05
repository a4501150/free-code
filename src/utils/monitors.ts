/**
 * Monitor system: background processes that stream output for the model to
 * react to, without blocking the conversation.
 *
 * Each monitor runs a shell command (e.g. `tail -f`, a polling script) in
 * the background. Output is buffered in a rolling window and surfaced to
 * the model either as a queued task-notification (next turn boundary) or
 * on demand via the MonitorList tool. Monitors are killed when the model
 * calls MonitorStop, when the process exits, or when the CLI exits.
 *
 * Ported from Snipe (vibes/Snipe src/core/monitors.ts), adapted to
 * free-code: notices ride the unified command queue instead of being
 * injected into session turn-building, and spawn/kill are injectable for
 * hermetic unit tests (no mock.module — unit tests share one process).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'
import treeKill from 'tree-kill'
import type { AgentId } from '../types/ids.js'
import { subprocessEnv } from './subprocessEnv.js'

export interface Monitor {
  /** Unique, stable id (mon_ + counter + timestamp). */
  id: string
  /** Human-readable label supplied by the model. */
  label: string
  /** The command being watched. */
  command: string
  /** Subagent that armed the monitor; undefined = main thread. Notices for
   *  this monitor are queued with this agentId so the query.ts drain gate
   *  routes them to the right conversation. */
  agentId?: AgentId
  /** Current status. */
  status: 'running' | 'stopped' | 'exited' | 'error'
  /** Exit code when status is 'exited' or 'error'. */
  exitCode?: number
  /** Rolling buffer of recent output lines (max MAX_OUTPUT_LINES). */
  output: string[]
  /** Output produced since the last notice. */
  newOutput: string[]
  /** Whether the monitor has un-notified output for the next notice. */
  hasUnnotifiedOutput: boolean
  /** Timestamp the monitor was started. */
  startedAt: number
  /** Timestamp the monitor stopped (exited or killed). */
  endedAt?: number
  /** Underlying child process. */
  child?: ChildProcess
}

/** Injected spawn used by tests; mirrors the node:child_process signature subset. */
export type SpawnFn = (
  command: string,
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
  },
) => ChildProcess

/** Injected process-tree kill used by tests. */
export type KillFn = (pid: number, callback: (err?: Error) => void) => void

const MAX_OUTPUT_LINES = 200
const MAX_NEW_OUTPUT_LINES = 50
const MAX_LINE_LENGTH = 1000
const DEBOUNCE_MS = 5000

const defaultSpawn: SpawnFn = (command, options) =>
  spawn(command, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

const defaultKill: KillFn = (pid, callback) => {
  treeKill(pid, 'SIGTERM', callback)
}

/**
 * Manages background monitor processes.
 *
 * Monitors are purely in-memory (not persisted to disk) because they run
 * commands that are inherently session-scoped: a `tail -f` from a previous
 * session is meaningless to resume. If the session restarts, monitors
 * are gone.
 */
export class MonitorManager {
  private _monitors = new Map<string, Monitor>()
  private _counter = 0

  /** Optional callback fired when a monitor produces new output. Used to
   *  enqueue a notice so the model can react at the next turn boundary.
   *  Debounced (DEBOUNCE_MS) to avoid flooding on high-output commands. */
  private _onOutput?: () => void
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _debounceMs: number
  /** Last line that triggered a notice, per monitor id. Suppresses identical
   *  consecutive output lines (e.g. a polling loop that prints the same
   *  "CI=pending" status every tick). */
  private _lastTriggeredLine = new Map<string, string>()
  private readonly _spawnFn: SpawnFn
  private readonly _killFn: KillFn
  private readonly _cwd: () => string

  constructor(
    options: {
      cwd?: () => string
      spawnFn?: SpawnFn
      killFn?: KillFn
      debounceMs?: number
      /** Register a best-effort process-exit killer. Tests pass false to
       *  avoid piling exit listeners from many short-lived managers. */
      attachExitHook?: boolean
    } = {},
  ) {
    this._spawnFn = options.spawnFn ?? defaultSpawn
    this._killFn = options.killFn ?? defaultKill
    this._cwd = options.cwd ?? (() => process.cwd())
    this._debounceMs = options.debounceMs ?? DEBOUNCE_MS
    if (options.attachExitHook !== false) {
      // Best-effort synchronous cleanup: detached children survive the
      // parent by design (they are session-scoped, not durable), so kill the
      // whole process group on exit. detached:true makes each child its own
      // process-group leader on POSIX, so -pid reaches the tree.
      process.on('exit', this._onProcessExit)
    }
  }

  private _onProcessExit = (): void => {
    for (const monitor of this._monitors.values()) {
      if (monitor.status !== 'running') continue
      const pid = monitor.child?.pid
      if (!pid) continue
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // Already dead (ESRCH) or not a group leader (Windows): the child
        // will be reaped by its own exit; nothing else to do synchronously.
      }
    }
  }

  /** Set the callback fired (debounced) when monitor output arrives. */
  onOutput(cb: (() => void) | undefined): void {
    this._onOutput = cb
  }

  /** Debounced trigger — fires at most once per debounce window. */
  private _triggerOutputCallback(): void {
    if (!this._onOutput) return
    if (this._debounceTimer) return
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined
      this._onOutput?.()
    }, this._debounceMs)
  }

  /** Cancel any pending debounce timer. */
  private _cancelDebounce(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = undefined
    }
  }

  /** Start a new monitor. Returns the monitor record. Never throws: a failed
   *  spawn is reported through the monitor's status/newOutput. */
  start(command: string, label: string, agentId?: AgentId): Monitor {
    const id = `mon_${++this._counter}_${Date.now().toString(36)}`
    const monitor: Monitor = {
      id,
      label,
      command,
      ...(agentId !== undefined ? { agentId } : {}),
      status: 'running',
      output: [],
      newOutput: [],
      hasUnnotifiedOutput: false,
      startedAt: Date.now(),
    }
    this._monitors.set(id, monitor)

    try {
      // Monitors run detached with no TTY: pin git's editors to the
      // non-interactive no-op so a git command in a watch loop can never
      // hang on an invisible vim (same headless contract as the Bash tool;
      // inline GIT_EDITOR=... in the monitored command still wins).
      const env = {
        ...subprocessEnv(),
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        CLAUDECODE: '1',
      }
      const child = this._spawnFn(command, { cwd: this._cwd(), env })
      monitor.child = child

      const appendLine = (line: string) => {
        const trimmed =
          line.length > MAX_LINE_LENGTH
            ? `${line.slice(0, MAX_LINE_LENGTH)}... [truncated]`
            : line
        monitor.output.push(trimmed)
        monitor.newOutput.push(trimmed)
        monitor.hasUnnotifiedOutput = true
        if (monitor.output.length > MAX_OUTPUT_LINES) {
          monitor.output.splice(0, monitor.output.length - MAX_OUTPUT_LINES)
        }
        if (monitor.newOutput.length > MAX_NEW_OUTPUT_LINES) {
          monitor.newOutput.splice(
            0,
            monitor.newOutput.length - MAX_NEW_OUTPUT_LINES,
          )
        }
        // Only trigger a notice when the output changes or the monitor
        // exits. A polling loop that prints the same status line every tick
        // should not flood the conversation. _lastTriggeredLine is advanced
        // in takeUnnotifiedOutput (not here) so that if the notice is
        // skipped while a pending one is queued, the next identical line
        // still triggers.
        const last = this._lastTriggeredLine.get(id)
        if (trimmed !== last) {
          this._triggerOutputCallback()
        }
      }

      if (child.stdout) {
        readline.createInterface({ input: child.stdout }).on('line', appendLine)
      }
      if (child.stderr) {
        readline.createInterface({ input: child.stderr }).on('line', appendLine)
      }

      // Guard against the exit/error handlers firing after stop() has
      // already transitioned the monitor to 'stopped'. Without this, the
      // async exit event triggered by the kill overwrites the status to
      // 'error'.
      const finalize = (fn: () => void) => {
        if (monitor.status === 'stopped') return
        fn()
        monitor.hasUnnotifiedOutput = true
        // Exit/error is always a status change — always trigger, even for
        // a line identical to the last one seen.
        this._lastTriggeredLine.delete(id)
        this._triggerOutputCallback()
      }

      child.on('exit', (code: number | null) => {
        finalize(() => {
          monitor.status = code === 0 ? 'exited' : 'error'
          monitor.exitCode = code ?? -1
          monitor.endedAt = Date.now()
          if (monitor.newOutput.length === 0) {
            monitor.newOutput.push(`[monitor exited with code ${code ?? -1}]`)
          }
        })
      })

      child.on('error', (err: Error) => {
        finalize(() => {
          monitor.status = 'error'
          monitor.endedAt = Date.now()
          monitor.newOutput.push(`[monitor error: ${err.message}]`)
        })
      })
    } catch (err) {
      monitor.status = 'error'
      monitor.endedAt = Date.now()
      monitor.hasUnnotifiedOutput = true
      monitor.newOutput.push(
        `[failed to start: ${err instanceof Error ? err.message : String(err)}]`,
      )
    }

    return monitor
  }

  /** Stop a monitor by id. Returns true if it was running and stopped. */
  stop(id: string): boolean {
    const monitor = this._monitors.get(id)
    if (!monitor) return false
    if (monitor.status !== 'running') return false

    const pid = monitor.child?.pid
    if (pid) {
      this._killFn(pid, () => {})
    }
    monitor.status = 'stopped'
    monitor.endedAt = Date.now()
    monitor.hasUnnotifiedOutput = true
    monitor.newOutput.push('[monitor stopped by model]')
    // Late exit/error events are no-ops via the status check in finalize.
    this._lastTriggeredLine.delete(id)
    this._triggerOutputCallback()
    return true
  }

  /** Get a monitor by id. */
  get(id: string): Monitor | undefined {
    return this._monitors.get(id)
  }

  /** List all monitors. */
  list(): Monitor[] {
    return Array.from(this._monitors.values())
  }

  /** Get monitors matching a predicate that have un-notified output, mark
   *  them as notified, and clear their newOutput buffer. Returns a snapshot
   *  of each monitor's newOutput for the caller to render. The predicate
   *  lets the notification layer enqueue one notice per agentId without
   *  consuming another agent's pending output. */
  takeUnnotifiedOutput(
    predicate?: (monitor: Monitor) => boolean,
  ): { monitor: Monitor; output: string[] }[] {
    const result: { monitor: Monitor; output: string[] }[] = []
    for (const monitor of this._monitors.values()) {
      if (!monitor.hasUnnotifiedOutput) continue
      if (predicate && !predicate(monitor)) continue
      result.push({ monitor, output: [...monitor.newOutput] })
      monitor.hasUnnotifiedOutput = false
      monitor.newOutput = []
      // Advance the change-detection marker to the last line the model is
      // about to see, so subsequent identical lines don't re-trigger. This
      // runs at notice time (not line-arrival time) so that a notice
      // skipped while another is queued doesn't lose its trigger.
      const lines = result[result.length - 1]!.output
      if (lines.length > 0) {
        this._lastTriggeredLine.set(monitor.id, lines[lines.length - 1]!)
      }
    }
    return result
  }

  /** Whether any monitor has un-notified output. */
  hasUnnotifiedOutput(): boolean {
    for (const monitor of this._monitors.values()) {
      if (monitor.hasUnnotifiedOutput) return true
    }
    return false
  }

  /** Stop all running monitors and detach the auto-trigger. Called on
   *  teardown to prevent ghost notices from readline events that fire after
   *  the manager is replaced. */
  stopAll(): void {
    this._cancelDebounce()
    this._onOutput = undefined
    for (const monitor of this._monitors.values()) {
      if (monitor.status !== 'running') continue
      const pid = monitor.child?.pid
      if (pid) {
        this._killFn(pid, () => {})
      }
      monitor.status = 'stopped'
      monitor.endedAt = Date.now()
    }
    this._lastTriggeredLine.clear()
  }

  /** Number of active (running) monitors. */
  get activeCount(): number {
    let count = 0
    for (const monitor of this._monitors.values()) {
      if (monitor.status === 'running') count++
    }
    return count
  }
}

let monitorManager: MonitorManager | undefined

/** Session-wide MonitorManager singleton. Created lazily so importing this
 *  module has no process side effects (unit tests import the class only). */
export function getMonitorManager(): MonitorManager {
  if (!monitorManager) {
    monitorManager = new MonitorManager()
  }
  return monitorManager
}
