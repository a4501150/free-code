/**
 * Loop-control types for the query generator in src/query.ts.
 *
 * - `Continue` is recorded on the loop state to explain why the previous
 *   iteration chose to loop instead of returning. Variants enumerated from
 *   every `transition: { reason: ... }` assignment in query.ts.
 * - `Terminal` is the generator's final return value; it describes why the
 *   turn ended. Variants enumerated from every `return { reason: ... }`
 *   site in query.ts.
 */

export type Continue =
  | { reason: 'collapse_drain_retry'; committed: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
  | { reason: 'next_turn' }

export type Terminal =
  | { reason: 'blocking_limit' }
  | { reason: 'image_error' }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'aborted_streaming' }
  | { reason: 'prompt_too_long' }
  | { reason: 'completed' }
  | { reason: 'stop_hook_prevented' }
  | { reason: 'aborted_tools' }
  | { reason: 'hook_stopped' }
  | { reason: 'max_turns'; turnCount: number }
