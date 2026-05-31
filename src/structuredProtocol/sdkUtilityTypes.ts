type NonNullableCacheCreation = {
  ephemeral_1h_input_tokens: number
  ephemeral_5m_input_tokens: number
  [key: string]: unknown
}

type NonNullableServerToolUsage = {
  web_search_requests: number
  web_fetch_requests: number
  [key: string]: unknown
}

type NonNullableIterationsUsage = unknown

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
  cache_creation: NonNullableCacheCreation
  server_tool_use: NonNullableServerToolUsage
  service_tier: 'standard' | 'priority' | 'batch' | string
  speed: 'standard' | 'fast' | string
  inference_geo: string
  iterations: NonNullableIterationsUsage
}
