/**
 * Probe for an already-running server instance.
 * Stub — the real implementation is not available in this build.
 */
export async function probeRunningServer(): Promise<{
  pid: number
  httpUrl: string
} | null> {
  return null
}

/**
 * Write the server lock file (~/.claude/server.lock).
 * Stub — the real implementation is not available in this build.
 */
export async function writeServerLock(_info: {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}): Promise<void> {}

/**
 * Remove the server lock file.
 * Stub — the real implementation is not available in this build.
 */
export async function removeServerLock(): Promise<void> {}
