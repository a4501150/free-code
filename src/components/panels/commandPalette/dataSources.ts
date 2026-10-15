/**
 * Data-source seam for the slash-command palette. The palette brain
 * (useTypeahead / CommandPalette) gets every non-prop piece of data through
 * this interface so any host can mount it: reactive snapshot fields are
 * read at render time (the host re-renders with fresh values when they
 * change), imperative methods are read at call time. The classic REPL wires
 * the store-backed default via useAppStateTypeaheadDataSources.
 */
import type { ServerResource } from '../../../services/mcp/types.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { ShellHistoryMatch } from '../../../utils/suggestions/shellHistoryCompletion.js'
import type { SuggestionItem } from './types.js'

/** Ghost-text suggestion the host is offering (right-arrow/Tab to accept). */
export type TypeaheadPromptSuggestion = {
  text: string | null
  shownAt: number
}

/** A named agent available for @name direct messages. */
export type TypeaheadAgentMember = {
  name: string
  status?: string
}

/** A /resume custom-title match, pre-formatted for suggestion rendering. */
export type TypeaheadSessionTitleMatch = {
  sessionId: string | undefined
  customTitle: string | undefined
  metadataLine: string
}

/**
 * Palette-originated notification (e.g. the thinking-toggle hint). Plain
 * text, not JSX: the host's notification surface renders and styles it
 * (the classic renders uncolored text dimmed).
 */
export type TypeaheadNotification = {
  key: string
  text: string
  priority: 'low' | 'medium' | 'high' | 'immediate'
  timeoutMs?: number
}

export type TypeaheadDataSources = {
  // ── Reactive snapshot (read at render; hosts re-render on change) ──
  /** MCP resources per server, for @server:resource suggestions. */
  mcpResources: Record<string, ServerResource[]>
  /** The host's current prompt suggestion. */
  promptSuggestion: TypeaheadPromptSuggestion
  /** True while the host is viewing an agent task (suppress ghost accept). */
  isViewingAgentTask: boolean

  // ── Call-time reads and actions ──
  /** Whether a Slack MCP server is connected (# trigger gate). */
  hasSlackMcpServer(): boolean
  /** Named agents for @name DM suggestions. */
  getAgentDirectMessages(): TypeaheadAgentMember[]
  /** /resume custom-title matches. */
  searchSessionTitleSuggestions(
    query: string,
  ): Promise<TypeaheadSessionTitleMatch[]>
  /** Pre-warm the file index so the first @-mention doesn't block. */
  startFileIndexRefresh(): void
  /** Subscribe to file-index build completion; returns unsubscribe. */
  onFileIndexBuildComplete(callback: () => void): () => void
  /** Surface a palette notification through the host's queue. */
  addNotification(content: TypeaheadNotification): void

  // ── Process-coupled lookups ──
  // The engine used to import these generators directly, which made it
  // host-agnostic only inside the classic process. The classic impl
  // delegates to the local modules; another host may serve them over its
  // own transport (a session-side RPC, a viewer-side index) behind the
  // same signatures.

  /** Fuzzy @-mention search over the file index, agents and MCP resources. */
  searchUnifiedSuggestions(
    query: string,
    mcpResources: Record<string, ServerResource[]>,
    agents: AgentDefinition[],
    showOnEmpty?: boolean,
  ): Promise<SuggestionItem[]>
  /** Subdirectory entries for a path-typed command argument (/add-dir). */
  getDirectoryCompletions(partialPath: string): Promise<SuggestionItem[]>
  /** Files+directories for a path-like @token (@~/, @./, @/). */
  getPathCompletions(
    partialPath: string,
    options: { maxResults?: number },
  ): Promise<SuggestionItem[]>
  /** Bash/zsh completion candidates (the classic spawns the shell). */
  getShellCompletions(
    input: string,
    cursorOffset: number,
    abortSignal: AbortSignal,
  ): Promise<SuggestionItem[]>
  /** Bash-mode history ghost-text match for the whole line. */
  getShellHistoryCompletion(input: string): Promise<ShellHistoryMatch | null>
  /** Slack #channel matches (the classic queries the Slack MCP server). */
  getSlackChannelSuggestions(searchToken: string): Promise<SuggestionItem[]>
}
