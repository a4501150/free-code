// Catalog scope partitioning: which catalog directory a server's declarations
// render into. Project-derived MCP config (`.mcp.json` at any ancestor, local
// project settings) renders into a project-keyed directory so concurrent
// sessions in different projects never fight over one shared file set — the
// user-level catalog stays for user/dynamic/claude.ai servers plus built-ins.
// See writer.ts for the directory format and attachments.ts for the per-turn
// delta pipeline that consumes this.

import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import type { Tool } from '../../Tool.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import type { MCPServerConnection } from '../mcp/types.js'

const CATALOG_DIR = 'tool-catalog'
const PROJECTS_DIR = 'projects'
const STATE_FILE = 'tool-catalog.json'

/** Filesystem-safe directory key for a project root path. */
export function catalogKeyForPath(path: string): string {
  return sanitizePath(path)
}

/**
 * Directory key for the current session's project catalog. Same identity rule
 * as transcripts (getProjectDir): the canonical git root, so all worktrees of
 * one repo share one catalog, falling back to the original cwd when outside a
 * repo. Derived from the ORIGINAL cwd (not per-agent overrides) and memoized,
 * so the key is stable for the process lifetime.
 */
export const projectCatalogKey = memoize((): string =>
  catalogKeyForPath(findCanonicalGitRoot(getOriginalCwd()) ?? getOriginalCwd()),
)

export function userCatalogDir(): string {
  return join(getClaudeConfigHomeDir(), CATALOG_DIR)
}

export function userCatalogStatePath(): string {
  return join(getClaudeConfigHomeDir(), STATE_FILE)
}

export function projectCatalogDir(): string {
  return join(
    getClaudeConfigHomeDir(),
    CATALOG_DIR,
    PROJECTS_DIR,
    projectCatalogKey(),
  )
}

/**
 * State file sits outside its catalog dir (sibling file), mirroring the user
 * catalog layout so directory cleanup can never delete a state file.
 */
export function projectCatalogStatePath(): string {
  return `${projectCatalogDir()}.json`
}

// 'project' (.mcp.json) and 'local' (local project settings) are both derived
// from this directory tree; everything else — user config, bundled/dynamic
// (agent-browser, plugins, --mcp-config, SDK), claude.ai connectors — is
// session-global and belongs in the user catalog.
const PROJECT_SCOPES = new Set(['project', 'local'])

export type CatalogPartition = {
  /** Tools rendered into the user-level catalog. */
  user: Tool[]
  /** Tools rendered into the project catalog. */
  project: Tool[]
  /** True when any server configured in this session maps to the project dir. */
  projectDirActive: boolean
}

/**
 * Which catalog dir each server's tools render into. Scope comes from the
 * session's client registry (any connection state — a pending or failed
 * project server still owns its project dir), not from connectivity, so a
 * slow-connecting server never re-homes its files. A server with no client
 * entry (older harness passing a bare pool) falls back to the user dir,
 * preserving the pre-split behavior.
 */
export function partitionToolsByCatalogDir(
  mcpTools: Tool[],
  mcpClients: MCPServerConnection[],
): CatalogPartition {
  const scopeByServer = new Map(
    mcpClients.map(c => [c.name, c.config.scope] as const),
  )
  const user: Tool[] = []
  const project: Tool[] = []
  let projectDirActive = false
  for (const client of mcpClients) {
    if (PROJECT_SCOPES.has(client.config.scope)) projectDirActive = true
  }
  for (const tool of mcpTools) {
    const server = tool.mcpInfo?.serverName
    const scope = server !== undefined ? scopeByServer.get(server) : undefined
    if (scope !== undefined && PROJECT_SCOPES.has(scope)) {
      project.push(tool)
    } else {
      user.push(tool)
    }
  }
  return { user, project, projectDirActive }
}

/**
 * Server names this session considers native to each catalog dir (from the
 * client registry, any connection state). The writer's age GC uses these to
 * never reap a file for a server some live session still has configured.
 */
export function knownServersByCatalogDir(mcpClients: MCPServerConnection[]): {
  user: Set<string>
  project: Set<string>
} {
  const user = new Set<string>()
  const project = new Set<string>()
  for (const client of mcpClients) {
    if (PROJECT_SCOPES.has(client.config.scope)) {
      project.add(client.name)
    } else {
      user.add(client.name)
    }
  }
  return { user, project }
}

/**
 * Slice of a full server-description map down to the servers a tool subset
 * covers, so each per-dir write only sees its own servers.
 */
export function subsetDescriptions(
  descriptions: Map<string, string>,
  tools: Tool[],
): Map<string, string> {
  const names = new Set(
    tools
      .map(t => t.mcpInfo?.serverName)
      .filter((n): n is string => n !== undefined),
  )
  return new Map([...descriptions].filter(([name]) => names.has(name)))
}
