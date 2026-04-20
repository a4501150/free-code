import type {
  BetaIterationsUsage,
  BetaServerToolUsage,
  BetaCacheCreation,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/**
 * Usage counters identical in shape to the SDK's `BetaUsage` but with every
 * nullable field tightened to a concrete default. We pre-initialize to zero
 * / empty strings / [] so the accumulator math in claude.ts can read fields
 * without `??`-guards on every access.
 *
 * The matching zero-initializer lives in src/services/api/emptyUsage.ts.
 */
export type NonNullableUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cache_creation: BetaCacheCreation
  server_tool_use: BetaServerToolUsage
  service_tier: 'standard' | 'priority' | 'batch' | string
  speed: 'standard' | 'fast' | string
  inference_geo: string
  iterations: BetaIterationsUsage | []
}
