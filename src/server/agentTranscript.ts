/**
 * Sidechain drill-down: loading one agent's transcript as a wire snapshot.
 *
 * Shared by every host that wants its browser clients to open an agent panel
 * (the hosted runtime, the TUI bridge). The loader reads the sidechain
 * JSONL — the same file the terminal's agent viewer reads — and serializes
 * it with the transcript's own serializer, so the panel renders the same
 * item shapes as the main transcript.
 */

import { getAgentTranscript } from '../utils/sessionStorage.js'
import type { AgentId } from '../types/ids.js'
import { toWireItems, wireSnapshot } from '../session/toWire.js'
import type { WireTranscriptSnapshot } from '../session/wire.js'

/** Agent ids are UUID-shaped; the route param is attacker-shaped. */
const AGENT_ID = /^[A-Za-z0-9_-]{8,64}$/

export async function loadAgentWireTranscript(
  agentId: string,
): Promise<WireTranscriptSnapshot | null> {
  if (!AGENT_ID.test(agentId)) return null
  const loaded = await getAgentTranscript(agentId as AgentId)
  if (!loaded) return null
  return wireSnapshot(toWireItems(loaded.messages))
}
