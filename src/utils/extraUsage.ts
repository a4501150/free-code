import { isClaudeAISubscriber } from './auth.js'
import { modelSupports1M } from './context.js'

export function isBilledAsExtraUsage(
  model: string | null,
  isFastMode: boolean,
): boolean {
  if (!isClaudeAISubscriber()) return false
  if (isFastMode) return true
  // Extra usage is billed for models with 1M context window
  if (model !== null && modelSupports1M(model)) return true
  return false
}
