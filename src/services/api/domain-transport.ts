/**
 * Provider-agnostic transport types.
 *
 * These types define the contract between adapters and the main streaming
 * loop. Adapters produce {@link DomainStreamingResponse} directly; the
 * main loop consumes domain types only.
 *
 * Request types ({@link DomainMessageRequest}) are structural supersets —
 * each adapter maps them to its native wire format internally.
 */
import type {
  DomainCacheControl,
  DomainContentBlock,
  DomainAssistantContent,
  DomainStreamEvent,
  DomainUserContentBlock,
} from '../../types/domain.js'

// ── Streaming Response ──────────────────────────────────────────────

export interface DomainStreamingResponse {
  stream: AsyncIterable<DomainStreamEvent>
  requestId?: string
  responseHeaders?: Record<string, string>
  abort(): void
  release(): void
}

// ── Request Types ───────────────────────────────────────────────────

export type DomainMessageParam =
  | { role: 'user'; content: DomainUserContentBlock[] }
  | { role: 'assistant'; content: DomainContentBlock[] }

export type DomainSystemBlock = {
  type: 'text'
  text: string
  cacheControl?: DomainCacheControl
  cacheScope?: string | null
}

export type DomainToolDefinition = {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  type?: string
  cacheControl?: DomainCacheControl
  cacheScope?: string | null
}

export type DomainThinkingConfig =
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' }

export type DomainToolChoice =
  | { type: 'auto'; disableParallelToolUse?: boolean }
  | { type: 'any' }
  | { type: 'tool'; name: string; disableParallelToolUse?: boolean }
  | { type: 'none' }

export type DomainMessageRequest = {
  model: string
  messages: DomainMessageParam[]
  system?: DomainSystemBlock[]
  tools?: DomainToolDefinition[]
  toolChoice?: DomainToolChoice
  maxTokens: number
  thinking?: DomainThinkingConfig
  temperature?: number
  speed?: string
  betas?: string[]
  metadata?: Record<string, unknown>
  extraBody?: Record<string, unknown>
  outputConfig?: Record<string, unknown>
  advisorModel?: string
  previousRequestId?: string
  contextManagement?: Record<string, unknown>
}

// Re-export domain types that adapters and the main loop both need
export type { DomainStreamEvent, DomainAssistantContent }
