import { spawn } from 'child_process'

/**
 * Replaces the daemon by handing the job to the CLI.
 *
 * The supervisor is the gateway process, so it cannot replace itself. Only
 * `web restart` reads `webui/state.json`, restores the previous start options
 * and re-requests the previous tunnel hostname, which is what keeps a URL
 * already open on a phone alive. Spawning that command reuses all of it instead
 * of reimplementing the sequence here.
 *
 * Detached, because the very next thing this child does is SIGTERM the process
 * that spawned it. A child in our process group would die with us, halfway
 * through, leaving no gateway at all.
 */
export function spawnDaemonRestart(): void {
  const child = spawn(process.execPath, ['web', 'restart'], {
    detached: true,
    stdio: 'ignore',
    // Inherited, so the replacement reads the same config home and settings.
    env: process.env,
  })
  child.unref()
}
