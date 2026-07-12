import type { QuerySource } from '../constants/querySource.js'
import { isAgenticQuerySource } from '../constants/querySource.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

export const AGENTIC_SYSTEM_PROMPT_INVARIANTS = `# Platform rules

- Only use emojis when the user explicitly requests them, including in file contents.
- For temporary files, use the session scratchpad when provided; otherwise use the platform-provided temporary directory (\`$TMPDIR\` on Unix or the platform equivalent). Never hardcode \`/tmp\` unless the user explicitly requests it.`

export function withAgenticSystemPromptInvariants(
  systemPrompt: SystemPrompt,
): SystemPrompt {
  if (systemPrompt.includes(AGENTIC_SYSTEM_PROMPT_INVARIANTS)) {
    return systemPrompt
  }
  return asSystemPrompt([AGENTIC_SYSTEM_PROMPT_INVARIANTS, ...systemPrompt])
}

export function withAgenticSystemPromptInvariantsForQuery(
  systemPrompt: SystemPrompt,
  querySource: QuerySource,
): SystemPrompt {
  return isAgenticQuerySource(querySource)
    ? withAgenticSystemPromptInvariants(systemPrompt)
    : systemPrompt
}
