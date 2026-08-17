import { spawn, type ChildProcess } from 'child_process'
import { validateSessionCwd } from './directories.js'
import { readAttachDescriptor } from '../attach/attachDescriptor.js'
import { WEBUI_ATTACH_ENV } from '../../utils/webuiManagedProcess.js'

export type ChildSession = {
  pid: number
  processKey: string
  cwd: string
  sessionId: string
}

const READY_TIMEOUT_MS = 30_000

/**
 * Permission flags the gateway hands to every session it spawns.
 *
 * A child loads the disk settings for its own directory on its own. These are
 * the operator's CLI choices, which a child cannot discover. There is
 * deliberately no bypass flag: this surface is reachable behind one password.
 */
export type ChildSessionDefaults = {
  permissionMode?: 'default' | 'acceptEdits' | 'plan'
  allowedTools?: string[]
  disallowedTools?: string[]
  settings?: string
  settingSources?: string
}

function defaultArgs(defaults: ChildSessionDefaults | undefined): string[] {
  if (!defaults) return []
  const args: string[] = []
  if (defaults.permissionMode) {
    args.push('--permission-mode', defaults.permissionMode)
  }
  if (defaults.allowedTools?.length) {
    args.push('--allowed-tools', ...defaults.allowedTools)
  }
  if (defaults.disallowedTools?.length) {
    args.push('--disallowed-tools', ...defaults.disallowedTools)
  }
  if (defaults.settings) args.push('--settings', defaults.settings)
  if (defaults.settingSources) {
    args.push('--setting-sources', defaults.settingSources)
  }
  return args
}

/**
 * Sessions the gateway started itself.
 *
 * A child is a normal headless CLI with the attach env var set, so it publishes
 * the same socket a terminal session does and the browser cannot tell the
 * difference once attached.
 */
export function createChildSessions(defaults?: ChildSessionDefaults) {
  const children = new Map<number, ChildProcess>()

  async function start(options: {
    cwd: string
    /**
     * Resume this session instead of starting a fresh one. The child adopts the
     * ID, so readiness is gated on the descriptor reporting it.
     */
    resumeSessionId?: string
  }): Promise<ChildSession> {
    // Before spawn, because spawn reports a bare errno the browser cannot
    // turn into advice. Every caller gets the check, not just the HTTP route.
    await validateSessionCwd(options.cwd)

    const child = spawn(
      process.execPath,
      [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        // Argv is an array, so the ID is never parsed by a shell. The caller
        // has already validated it as a UUID.
        ...(options.resumeSessionId
          ? ['--resume', options.resumeSessionId]
          : []),
        ...defaultArgs(defaults),
      ],
      {
        cwd: options.cwd,
        // The gateway's own PID, so a grandchild that inherits the variable
        // cannot pass for a process this gateway spawned.
        env: { ...process.env, [WEBUI_ATTACH_ENV]: String(process.pid) },
        // stdin stays open: closing it ends the headless session immediately.
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      },
    )

    if (!child.pid) throw new Error('failed to spawn a session')
    children.set(child.pid, child)
    child.once('exit', () => children.delete(child.pid!))

    // Drain the child's output so a full pipe buffer cannot stall it. The
    // browser reads the transcript over the attach socket, not from stdout.
    child.stdout?.resume()
    child.stderr?.resume()

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const descriptor = readAttachDescriptor(child.pid)
      // A resumed child publishes its descriptor only after the resume loaded,
      // so a mismatched ID means the resume has not been adopted. Returning on
      // the first descriptor would report success for a child that then exits,
      // which is what a nonexistent session or a holder conflict does.
      if (
        descriptor.ok &&
        (!options.resumeSessionId ||
          descriptor.descriptor.sessionId === options.resumeSessionId)
      ) {
        return {
          pid: child.pid,
          processKey: `${child.pid}:${descriptor.descriptor.processNonce}`,
          cwd: options.cwd,
          sessionId: descriptor.descriptor.sessionId,
        }
      }
      if (child.exitCode !== null) {
        throw new Error(`the session exited with code ${child.exitCode}`)
      }
      await Bun.sleep(150)
    }

    child.kill('SIGTERM')
    throw new Error('the session did not become attachable')
  }

  /**
   * Ends a child. SIGTERM lets registered cleanup run, which removes the PID
   * entry and the socket. Deleting those files is not stopping a session.
   */
  function stop(pid: number): boolean {
    const child = children.get(pid)
    if (!child) return false
    child.kill('SIGTERM')
    return true
  }

  function stopAll(): void {
    for (const [pid] of children) stop(pid)
  }

  function owns(pid: number): boolean {
    return children.has(pid)
  }

  return { start, stop, stopAll, owns }
}

export type ChildSessions = ReturnType<typeof createChildSessions>
