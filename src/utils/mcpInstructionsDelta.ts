import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import type { Message } from '../types/message.js'

export type McpInstructionsDelta = {
  /** Server names — for stateless-scan reconstruction. */
  addedNames: string[]
  /** Rendered "## {name}\n{instructions}" blocks for addedNames. */
  addedBlocks: string[]
  removedNames: string[]
}

/**
 * Diff the set of connected MCP servers that carry InitializeResult
 * instructions against what's already been announced in this conversation.
 * Null if nothing changed.
 *
 * Instructions are immutable for the life of a connection (set once at
 * handshake), so the scan diffs on server NAME, not on content.
 */
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
): McpInstructionsDelta | null {
  const announced = new Set<string>()
  for (const msg of messages) {
    if (
      msg.type !== 'attachment' ||
      msg.attachment.type !== 'mcp_instructions_delta'
    ) {
      continue
    }
    for (const n of msg.attachment.addedNames) announced.add(n)
    for (const n of msg.attachment.removedNames) announced.delete(n)
  }

  const connected = mcpClients.filter(
    (c): c is ConnectedMCPServer => c.type === 'connected',
  )
  const connectedNames = new Set(connected.map(c => c.name))

  const blocks = new Map<string, string>()
  for (const c of connected) {
    if (c.instructions) blocks.set(c.name, `## ${c.name}\n${c.instructions}`)
  }

  const added: Array<{ name: string; block: string }> = []
  for (const [name, block] of blocks) {
    if (!announced.has(name)) added.push({ name, block })
  }

  // A previously-announced server that is no longer connected → removed.
  // There is no "announced but now has no instructions" case for a still-
  // connected server: InitializeResult is immutable. Treat history as
  // historical — no retroactive retractions.
  const removed: string[] = []
  for (const n of announced) {
    if (!connectedNames.has(n)) removed.push(n)
  }

  if (added.length === 0 && removed.length === 0) return null

  added.sort((a, b) => a.name.localeCompare(b.name))
  return {
    addedNames: added.map(a => a.name),
    addedBlocks: added.map(a => a.block),
    removedNames: removed.sort(),
  }
}
