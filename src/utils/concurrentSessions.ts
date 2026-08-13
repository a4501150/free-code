import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getAgentId } from './teammate.js'

export const SESSION_KINDS = [
  'interactive',
  'bg',
  'daemon',
  'daemon-worker',
] as const
export type SessionKind = (typeof SESSION_KINDS)[number]
export type SessionStatus = 'busy' | 'idle' | 'waiting'

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

function envSessionKind(): SessionKind | undefined {
  return undefined
}

export function isBgSession(): boolean {
  return false
}

/**
 * Write a PID file for this session and register cleanup.
 *
 * Registers all top-level sessions — interactive CLI, SDK (vscode, desktop,
 * typescript, python, -p), and daemon spawns — so concurrency checks see
 * active sessions. Skips only teammates/subagents, which would
 * conflate swarm usage with genuine concurrency and pollute ps with noise.
 *
 * Returns true if registered, false if skipped.
 * Errors logged to debug, never thrown.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  registerCleanup(async () => {
    try {
      await unlink(pidFile)
    } catch {
      // ENOENT is fine (already deleted or never written)
    }
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await writeFile(
      pidFile,
      jsonStringify({
        pid: process.pid,
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        startedAt: Date.now(),
        kind,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      }),
    )
    // --resume / /resume mutates getSessionId() via switchSession. Without
    // this, the PID file's sessionId goes stale.
    onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (e) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    return false
  }
}

/**
 * Update this session's name in its PID registry file so ListPeers
 * can surface it. Best-effort: silently no-op if name is falsy, the
 * file doesn't exist (session not registered), or read/write fails.
 */
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(pidFile, jsonStringify({ ...data, ...patch }))
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`,
    )
  }
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

export async function updateSessionActivity(_patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {}

/**
 * Count live concurrent CLI sessions (including this one).
 * Filters out stale PID files (crashed sessions) and deletes them.
 * Returns 0 on any error (conservative).
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    // Strict filename guard: only `<pid>.json` is a candidate. parseInt's
    // lenient prefix-parsing means `2026-03-14_notes.md` would otherwise
    // parse as PID 2026 and get swept as stale — silent user data loss.
    // See anthropics/claude-code#34210.
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // Stale file from a crashed session — sweep it. Skip on WSL: if
      // ~/.freecode/sessions/ is shared with Windows-native Claude (symlink
      // or FREECODE_CONFIG_DIR), a Windows PID won't be probeable from WSL
      // and we'd falsely delete a live session's file. This is just
      // telemetry so conservative undercount is acceptable.
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}

export type ConcurrentSessionEntry = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: SessionKind
  entrypoint?: string
  name?: string
}

async function readSessionEntry(
  path: string,
  filenamePid: number,
): Promise<ConcurrentSessionEntry | null> {
  let data: unknown
  try {
    data = jsonParse(await readFile(path, 'utf8'))
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] unreadable entry ${path}: ${errorMessage(e)}`,
    )
    return null
  }
  if (typeof data !== 'object' || data === null) return null

  const { pid, sessionId, cwd, startedAt, kind, entrypoint, name } =
    data as Record<string, unknown>

  // The filename is what liveness was probed against, so a body claiming a
  // different PID describes some other process and can't be trusted to
  // report it.
  if (pid !== filenamePid) {
    logForDebugging(
      `[concurrentSessions] entry ${path} claims pid ${String(pid)}`,
    )
    return null
  }
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof cwd !== 'string') return null
  if (!Number.isFinite(startedAt) || (startedAt as number) <= 0) return null
  if (!SESSION_KINDS.includes(kind as SessionKind)) return null
  if (entrypoint !== undefined && typeof entrypoint !== 'string') return null
  if (name !== undefined && typeof name !== 'string') return null

  return {
    pid: filenamePid,
    sessionId,
    cwd,
    startedAt: startedAt as number,
    kind: kind as SessionKind,
    ...(entrypoint ? { entrypoint } : {}),
    ...(name ? { name } : {}),
  }
}

/**
 * Live sessions holding `sessionId`, excluding this process.
 *
 * Read-only on purpose. This answers an ownership question, so unlike
 * countConcurrentSessions it must not sweep: a PID that isn't probeable from
 * here belongs to a session we have no business deleting. That same
 * unprobeability makes the answer fail open — isProcessRunning collapses
 * EPERM to false, so a holder owned by another user is missed rather than
 * falsely reported. It is also not a lock; a holder can exit immediately
 * after the read.
 */
export async function getLiveSessionHolders(
  sessionId: string,
): Promise<ConcurrentSessionEntry[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(
        `[concurrentSessions] holder readdir failed: ${errorMessage(e)}`,
      )
    }
    return []
  }

  const holders: ConcurrentSessionEntry[] = []
  await Promise.all(
    files.map(async file => {
      // Same strict filename guard as countConcurrentSessions.
      if (!/^\d+\.json$/.test(file)) return
      const pid = parseInt(file.slice(0, -5), 10)
      if (pid === process.pid) return
      if (!isProcessRunning(pid)) return

      const entry = await readSessionEntry(join(dir, file), pid)
      if (entry && entry.sessionId === sessionId) holders.push(entry)
    }),
  )

  return holders.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
}

/**
 * Every live session on this machine, this process included.
 *
 * Same strict validation as getLiveSessionHolders and the same read-only,
 * fail-open behavior: a PID we cannot probe is omitted, never swept. Unlike
 * that function this does not filter by session ID, because the WebUI lists
 * processes rather than asking who owns one session.
 */
export async function listLiveSessions(): Promise<ConcurrentSessionEntry[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(
        `[concurrentSessions] live readdir failed: ${errorMessage(e)}`,
      )
    }
    return []
  }

  const entries: ConcurrentSessionEntry[] = []
  await Promise.all(
    files.map(async file => {
      if (!/^\d+\.json$/.test(file)) return
      const pid = parseInt(file.slice(0, -5), 10)
      if (!isProcessRunning(pid)) return
      const entry = await readSessionEntry(join(dir, file), pid)
      if (entry) entries.push(entry)
    }),
  )

  return entries.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
}
