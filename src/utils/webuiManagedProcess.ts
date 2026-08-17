/**
 * Identifies a session process the WebUI gateway spawned and manages.
 *
 * Imports nothing that reaches the filesystem, because `concurrentSessions`,
 * the headless attach bridge and the gateway's child spawner all need this and
 * they sit on opposite sides of the WebUI boundary.
 */

/**
 * Carries the gateway's PID, not a flag. Every descendant inherits the value,
 * so a `claude` that the Bash tool starts inside a managed session would answer
 * to a bare `1` and publish a control socket nobody asked for.
 */
export const WEBUI_ATTACH_ENV = 'CLAUDE_CODE_WEBUI_ATTACH'

/** Split out from the latch below so it can be exercised without a live parent. */
export function isManagedChild(raw: string | undefined, ppid: number): boolean {
  if (!raw) return false
  const managerPid = Number(raw)
  if (!Number.isInteger(managerPid) || managerPid <= 0) return false
  return ppid === managerPid
}

/**
 * Latched at load. The gateway can exit later, which reparents this process and
 * changes `process.ppid`, but that must not retract an identity the session was
 * started with.
 */
const managed: boolean = isManagedChild(
  process.env[WEBUI_ATTACH_ENV],
  process.ppid,
)

export function isWebuiManagedProcess(): boolean {
  return managed
}
