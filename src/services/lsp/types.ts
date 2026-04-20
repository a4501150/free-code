/**
 * LSP server configuration types.
 *
 * Shape mirrors the LspServerConfigSchema Zod schema declared in
 * src/utils/plugins/schemas.ts; keep them in sync. ScopedLspServerConfig
 * extends the base schema with scope/source fields populated by
 * addPluginScopeToLspServers in
 * src/utils/plugins/lspPluginIntegration.ts.
 */

export type LspTransport = 'stdio' | 'socket'

export type LspServerConfig = {
  /** Command to execute the LSP server (must not contain spaces; use args). */
  command: string
  /** Command-line arguments. */
  args?: string[]
  /** Mapping from file extension → LSP language ID. */
  extensionToLanguage: Record<string, string>
  /** Transport mechanism. Defaults to 'stdio' in the schema. */
  transport?: LspTransport
  /** Extra environment variables. */
  env?: Record<string, string>
  /** Initialization options passed during LSP initialize. */
  initializationOptions?: unknown
  /** Settings passed via workspace/didChangeConfiguration. */
  settings?: unknown
  /** Override workspace folder. */
  workspaceFolder?: string
  /** Startup timeout in milliseconds. */
  startupTimeout?: number
  /** Graceful shutdown timeout in milliseconds. */
  shutdownTimeout?: number
  /** Whether to auto-restart on crash. */
  restartOnCrash?: boolean
  /** Maximum number of restart attempts before giving up. */
  maxRestarts?: number
}

/**
 * Scope tag associated with an LSP server configuration, identifying where
 * the configuration came from. 'dynamic' is used for plugin-provided
 * servers.
 */
export type LspServerScope = 'user' | 'project' | 'local' | 'dynamic'

/**
 * An LspServerConfig with the scope it was loaded from, plus the source
 * (plugin name for dynamic servers) for display / diagnostics.
 */
export type ScopedLspServerConfig = LspServerConfig & {
  scope: LspServerScope
  source?: string
}

/**
 * Lifecycle state of an LSPServerInstance. Values observed at every
 * assignment site in src/services/lsp/LSPServerInstance.ts.
 */
export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'
