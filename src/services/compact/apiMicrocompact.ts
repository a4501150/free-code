// Context management strategy types matching API documentation
export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: {
        type: 'input_tokens'
        value: number
      }
      keep?: {
        type: 'tool_uses'
        value: number
      }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: {
        type: 'input_tokens'
        value: number
      }
    }
  | {
      type: 'clear_thinking_20251015'
      keep: { type: 'thinking_turns'; value: number } | 'all'
    }

// Context management configuration wrapper
export type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}

// Native context management. Always emits `keep: 'all'` so the server-side
// default policy can't trim thinking out from under us. Matches the shape
// shipped in the official CLI 2.1.119 after Anthropic removed the earlier
// >1h-idle latch that caused the "forgetful/repetitive" regression.
export function getAPIContextManagement(options?: {
  hasThinking?: boolean
}): ContextManagementConfig | undefined {
  const { hasThinking = false } = options ?? {}

  const strategies: ContextEditStrategy[] = []

  if (hasThinking) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: 'all',
    })
  }

  return strategies.length > 0 ? { edits: strategies } : undefined
}
