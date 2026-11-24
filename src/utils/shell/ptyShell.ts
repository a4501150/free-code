import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'

/**
 * Interactive PTY execution.
 *
 * Why the native node-pty addon is driven DIRECTLY, bypassing its JS wrapper:
 * node-pty's `UnixTerminal` wraps the PTY master fd in `tty.ReadStream`, and
 * Bun's `tty.ReadStream` is fs.ReadStream-backed — a threadpool read on the
 * O_NONBLOCK master fd returns EAGAIN, which errorOrDestroy-turns into
 * stream destroy + fd close (oven-sh/bun#29112; fix #29114 unreleased as of
 * Bun 1.4.4). Children died after their first output chunk and resize threw
 * EBADF. Loading the addon ourselves and running an EAGAIN-tolerant read
 * loop sidesteps the broken layer entirely; everything below was verified
 * against Bun 1.4.4 (password prompts via forkpty's controlling tty, resize,
 * long-running children, exit codes).
 *
 * The addon comes from @lydell/node-pty's per-platform prebuilt packages
 * (no lifecycle scripts — safe under Bun's default script blocking). In a
 * compiled binary the node_modules tree doesn't exist, so a vendored sidecar
 * is resolved next to the executable first, mirroring vendor/ripgrep.
 */

const require = createRequire(import.meta.url)

export interface PtyAddon {
  fork: (
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helperPath: string,
    onExit: (code: number, signal: number) => void,
  ) => { fd: number; pid: number; pty: string }
  resize: (
    fd: number,
    cols: number,
    rows: number,
    xPixel: number,
    yPixel: number,
  ) => void
}

let addon: PtyAddon | undefined
/**
 * The `spawn-helper` that lives next to whichever `pty.node` was loaded. The
 * addon posix_spawns it for the fork+setsid+exec leg; a wrong path surfaces
 * as "posix_spawn failed: No such file or directory" and every interactive
 * run dies before it produces a byte.
 */
let addonHelperPath: string | undefined

/** Only the POSIX addon is driven directly today; Windows (ConPTY) is future work. */
export function isPtySupported(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin'
}

function resolveAddon(): PtyAddon {
  if (addon) return addon

  // Compiled binary: vendored sidecar next to the executable. execPath is
  // the bun binary itself in dev mode, where this candidate simply won't exist.
  // Whoever rebuilds a vendored pty.node must ship its matching spawn-helper
  // in the same directory — the addon fails every fork without it.
  const execDir = path.dirname(process.execPath)
  const sidecar = path.resolve(
    execDir,
    'vendor',
    'node-pty',
    `${process.arch}-${process.platform}`,
    'pty.node',
  )
  try {
    addon = require(sidecar) as PtyAddon
    addonHelperPath = path.join(path.dirname(sidecar), 'spawn-helper')
    return addon
  } catch {
    // try the node_modules resolution next
  }

  // Dev / uncompiled: the per-platform package from node_modules, resolved
  // relative to this module (NOT process.cwd()). Bun's require.resolve won't
  // resolve raw `.node` subpaths, so anchor on the package's package.json.
  const pkg = `@lydell/node-pty-${process.platform}-${process.arch}`
  try {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`)
    const addonPath = path.join(
      path.dirname(pkgJsonPath),
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'pty.node',
    )
    addon = require(addonPath) as PtyAddon
    addonHelperPath = path.join(path.dirname(addonPath), 'spawn-helper')
    return addon
  } catch {
    throw new Error(
      `node-pty addon not found — run \`bun install\` or restore the vendor/node-pty/${process.arch}-${process.platform} sidecar next to the binary`,
    )
  }
}

export interface PtySpawnOptions {
  /** Executable to run under the PTY (e.g. the user's shell). */
  file: string
  /** Args for the executable (e.g. ['-c', commandString]). */
  args: string[]
  env: Record<string, string>
  cwd: string
  cols: number
  rows: number
  /**
   * Raw PTY bytes as they arrive (stdout and stderr merged — a PTY has one
   * stream). The buffer view is only valid until the callback returns:
   * consumers must finish with it synchronously.
   */
  onOutput: (data: Buffer) => void
  /** Fires once the child exited AND all tail bytes have been drained. */
  onClosed: (code: number, signal: number) => void
}

export interface PtyHandle {
  /** Input to the child. Never logged — may carry passwords. */
  write(data: string): void
  resize(cols: number, rows: number): void
}

/**
 * Live interactive shells by task id — the shared control surface for the
 * TUI progress view and the WebUI's task_input/task_resize frames. Input
 * written here is NEVER persisted to transcripts or logs.
 */
const livePtyHandles = new Map<string, PtyHandle>()
/**
 * The most recently registered run. Backgrounded interactive runs stay in
 * the map (the WebUI drives them via task_input by task id), but the TUI's
 * keystroke forwarding must route to the run the user is actually watching
 * — last-registered, i.e. the current foreground — not whichever the Map
 * happens to yield first.
 */
let foregroundPtyTaskId: string | undefined

export function registerPtyHandle(taskId: string, handle: PtyHandle): void {
  livePtyHandles.set(taskId, handle)
  foregroundPtyTaskId = taskId
}

export function unregisterPtyHandle(taskId: string): void {
  livePtyHandles.delete(taskId)
  if (foregroundPtyTaskId === taskId) foregroundPtyTaskId = undefined
}

export function getPtyHandle(taskId: string): PtyHandle | undefined {
  return livePtyHandles.get(taskId)
}

/**
 * The foreground interactive shell, if any — the one TUI keystrokes route
 * to. Backgrounded runs stay reachable via getPtyHandle(taskId) for the
 * WebUI, but receive no typed TUI input (identical to today, where stdin
 * is /dev/null).
 */
export function getSinglePtyHandle(): PtyHandle | undefined {
  return foregroundPtyTaskId === undefined
    ? undefined
    : livePtyHandles.get(foregroundPtyTaskId)
}

/**
 * Whether taskId is the foreground interactive run — the one the TUI's VT
 * panel tracks. Backgrounded runs stay drivable from the WebUI via
 * getPtyHandle(taskId) but must not feed the panel.
 */
export function isForegroundPtyTask(taskId: string): boolean {
  return foregroundPtyTaskId === taskId
}

/**
 * A ChildProcess-shaped facade over the raw PTY addon so ShellCommandImpl's
 * file-mode handling (null stdout/stderr, tree-kill by pid, 'exit' event)
 * works without modification. Signal deaths surface as 128+signal on the
 * 'exit' event, matching the SIGKILL=137 / SIGTERM=143 conventions
 * ShellCommandImpl already checks.
 */
export interface PtyChildProcess extends ChildProcess {
  pty: PtyHandle
}

const EAGAIN_RETRY_MS = 10
const EAGAIN_IDLE_RETRY_MS = 50
/** Consecutive empty reads before the idle retry interval kicks in. */
const EAGAIN_IDLE_AFTER = 32
/** Grace for the tail drain after child exit before forcing the close. */
const EXIT_DRAIN_GRACE_MS = 2000

/**
 * PTY output carries the line discipline's CRLF; the transcript and the
 * TUI's line-based views want LF. The capture file keeps raw bytes — the
 * WebUI terminal replays them — so normalize only at display/persist edges.
 */
export function normalizePtyOutput(text: string): string {
  return text.includes('\r') ? text.replaceAll('\r\n', '\n') : text
}

export function spawnPtyChild(opts: PtySpawnOptions): PtyChildProcess {
  const native = resolveAddon()
  const bus = new EventEmitter()
  // The helper must sit beside the loaded pty.node (resolveAddon records it);
  // a nonexistent path fails the spawn outright with ENOENT.
  const helperPath = addonHelperPath!

  let closed = false
  let exited = false
  let exitCode = 0
  let exitSignal = 0
  let drainPending = false
  let exitWatchdog: NodeJS.Timeout | undefined
  const envPairs = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)

  const finish = (): void => {
    if (closed) return
    if (!exited) {
      // The read loop hit EOF before the addon reported the exit code —
      // deferring would emit a bogus code 0; emitting now races the real
      // values. Park: the exit callback re-runs finish() with them.
      drainPending = true
      return
    }
    closed = true
    if (exitWatchdog !== undefined) clearTimeout(exitWatchdog)
    try {
      fs.closeSync(term.fd)
    } catch {
      // already closed
    }
    bus.emit('exit', exitSignal > 0 ? 128 + exitSignal : exitCode)
    opts.onClosed(exitCode, exitSignal)
  }

  const term = native.fork(
    opts.file,
    opts.args,
    envPairs,
    opts.cwd,
    opts.cols,
    opts.rows,
    -1,
    -1,
    true,
    helperPath,
    (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      // The exit event must NOT fire here: the PTY can still hold tail
      // bytes the read loop hasn't delivered, and the exit consumer reads
      // the output file the moment it sees 'exit' — an immediate emit
      // races the drain and silently truncates the result. finish() emits
      // once the read loop hits EIO (all bytes drained). A grandchild that
      // inherited the slave keeps the master readable forever, so a
      // watchdog forces the drain-close after a grace period.
      exitWatchdog = setTimeout(finish, EXIT_DRAIN_GRACE_MS)
      exitWatchdog.unref?.()
      if (drainPending) finish()
    },
  )

  // EAGAIN-tolerant read loop — the piece Bun's tty.ReadStream gets wrong.
  // While data flows, keep reading without a timer between full chunks; on
  // sustained silence, stretch the retry so an idle prompt costs ~20
  // threadpool reads/sec instead of 100. The timer stays ref'd on purpose:
  // it is the loop's heartbeat — unref'ing it could let the process exit and
  // SIGHUP a live child.
  const buf = Buffer.alloc(64 * 1024)
  let idleReads = 0
  const read = (): void => {
    if (closed) return
    fs.read(term.fd, buf, 0, buf.length, null, (err, bytesRead) => {
      if (closed) return
      if (err) {
        const errno = (err as NodeJS.ErrnoException).code
        if (errno === 'EAGAIN' || errno === 'EWOULDBLOCK') {
          idleReads += 1
          setTimeout(
            read,
            idleReads >= EAGAIN_IDLE_AFTER
              ? EAGAIN_IDLE_RETRY_MS
              : EAGAIN_RETRY_MS,
          )
          return
        }
        if (errno === 'EIO') {
          // Child exited and the tail is drained.
          finish()
          return
        }
        bus.emit('error', err)
        return
      }
      if (bytesRead > 0) {
        idleReads = 0
        opts.onOutput(buf.subarray(0, bytesRead))
      }
      // Full buffer means more is buffered in the PTY — drain it in place.
      if (bytesRead === buf.length) {
        read()
        return
      }
      setTimeout(read, 0)
    })
  }

  const handle: PtyHandle = {
    write(data: string): void {
      if (closed) return
      const b = Buffer.from(data, 'utf8')
      const writeAt = (off: number): void => {
        if (closed || off >= b.length) return
        fs.write(term.fd, b, off, b.length - off, (err, written) => {
          if (err) {
            const errno = (err as NodeJS.ErrnoException).code
            if (errno === 'EAGAIN' || errno === 'EWOULDBLOCK') {
              setTimeout(() => writeAt(off), EAGAIN_RETRY_MS)
              return
            }
            bus.emit('error', err)
            return
          }
          writeAt(off + written)
        })
      }
      writeAt(0)
    },
    resize(cols: number, rows: number): void {
      if (closed) return
      native.resize(term.fd, cols, rows, 0, 0)
    },
  }

  const child = {
    pid: term.pid,
    // tree-kill targets the pid's process group; a forkpty child is its own
    // session leader, so signal delivery needs no ChildProcess machinery.
    kill: (sig: NodeJS.Signals = 'SIGHUP') => {
      try {
        process.kill(term.pid, sig)
      } catch {
        // already dead
      }
    },
    once: bus.once.bind(bus),
    stdout: null,
    stderr: null,
    stdin: null,
    pty: handle,
  } as unknown as PtyChildProcess

  read()
  return child
}
