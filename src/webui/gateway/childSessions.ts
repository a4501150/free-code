import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { readAttachDescriptor } from '../attach/attachDescriptor.js'
import { WEBUI_ATTACH_ENV } from '../attach/headlessBridge.js'

export type ChildSession = {
  pid: number
  processKey: string
  cwd: string
}

const READY_TIMEOUT_MS = 30_000

/**
 * Sessions the gateway started itself.
 *
 * A child is a normal headless CLI with the attach env var set, so it publishes
 * the same socket a terminal session does and the browser cannot tell the
 * difference once attached.
 */
export function createChildSessions() {
  const children = new Map<number, ChildProcess>()

  async function start(options: { cwd: string }): Promise<ChildSession> {
    if (!existsSync(options.cwd)) {
      throw new Error(`no such directory: ${options.cwd}`)
    }

    const child = spawn(
      process.execPath,
      [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      {
        cwd: options.cwd,
        env: { ...process.env, [WEBUI_ATTACH_ENV]: '1' },
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
      if (descriptor.ok) {
        return {
          pid: child.pid,
          processKey: `${child.pid}:${descriptor.descriptor.processNonce}`,
          cwd: options.cwd,
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
