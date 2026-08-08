import { CLI_SYSPROMPT_PREFIXES } from '../../constants/system.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'

export type SystemPromptBlock = {
  text: string
  cached: boolean
}

/**
 * Split the system prompt into the three blocks the API matches on. See
 * https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_cli_system_prompt_prefixes
 *
 * - Attribution header — never cached. Its `cch=` field is a hash of the whole
 *   request body, so it differs on every request.
 * - CLI sysprompt prefix — never cached. At ~30 tokens a breakpoint here would
 *   only cover `tools + attribution + prefix`, which the tools breakpoint
 *   already covers without the varying attribution block.
 * - Everything else — the one cached system block.
 *
 * Blocks are identified by content rather than position because callers append
 * and prepend around them.
 */
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
): SystemPromptBlock[] {
  let attributionHeader: string | undefined
  let systemPromptPrefix: string | undefined
  const rest: string[] = []

  for (const block of systemPrompt) {
    if (!block) continue

    if (block.startsWith('x-anthropic-billing-header')) {
      attributionHeader = block
    } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
      systemPromptPrefix = block
    } else {
      rest.push(block)
    }
  }

  const result: SystemPromptBlock[] = []
  if (attributionHeader) {
    result.push({ text: attributionHeader, cached: false })
  }
  if (systemPromptPrefix) {
    result.push({ text: systemPromptPrefix, cached: false })
  }
  const restJoined = rest.join('\n\n')
  if (restJoined) {
    result.push({ text: restJoined, cached: true })
  }
  return result
}
