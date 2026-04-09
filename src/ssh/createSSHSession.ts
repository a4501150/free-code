import type {
  SSHSessionCallbacks,
  SSHSessionManager,
} from './SSHSessionManager.js'

export class SSHSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHSessionError'
  }
}

export type SSHSession = {
  remoteCwd: string
  proc: {
    exitCode: number | null
    signalCode: string | null
  }
  proxy: {
    stop(): void
  }
  createManager(callbacks: SSHSessionCallbacks): SSHSessionManager
  getStderrTail(): string
}

/**
 * Create an SSH session to a remote host.
 * Stub — the real implementation is not available in this build.
 */
export async function createSSHSession(
  _opts: {
    host: string
    cwd?: string
    localVersion: string
    permissionMode?: string
    dangerouslySkipPermissions?: boolean
    extraCliArgs?: string[]
  },
  _callbacks?: { onProgress?: (msg: string) => void },
): Promise<SSHSession> {
  throw new SSHSessionError('SSH sessions are not available in this build')
}

/**
 * Create a local SSH session for testing.
 * Stub — the real implementation is not available in this build.
 */
export function createLocalSSHSession(_opts: {
  cwd?: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
}): SSHSession {
  throw new SSHSessionError(
    'Local SSH sessions are not available in this build',
  )
}
