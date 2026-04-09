export type ServerLogger = {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

/**
 * Create a server logger.
 * Stub — the real implementation is not available in this build.
 */
export function createServerLogger(): ServerLogger {
  return {
    info() {},
    warn() {},
    error() {},
  }
}
