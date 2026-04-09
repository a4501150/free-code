import type { ServerConfig } from './types.js'
import type { SessionManager } from './sessionManager.js'
import type { ServerLogger } from './serverLog.js'

/**
 * Start the Direct Connect server.
 * Stub — the real implementation is not available in this build.
 */
export function startServer(
  _config: ServerConfig,
  _sessionManager: SessionManager,
  _logger: ServerLogger,
): { port?: number; stop(force: boolean): void } {
  return {
    port: undefined,
    stop() {},
  }
}
