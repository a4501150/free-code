import type { TokenCountMessageParam, TokenCountToolParam } from '../adapter.js'

export type GptTokenizerModule = {
  encode: (text: string) => number[]
}

export function serializeForTokenization(
  messages: TokenCountMessageParam[],
  tools: TokenCountToolParam[],
  system?: string,
): string {
  const parts: string[] = []
  if (system) parts.push(`system:\n${system}`)
  for (const t of tools) {
    const name = (t as { name?: string }).name
    if (!name) continue
    parts.push(
      `tool:${name}\n${(t as { description?: string }).description ?? ''}\n${JSON.stringify((t as { input_schema?: unknown }).input_schema ?? {})}`,
    )
  }
  for (const m of messages) {
    parts.push(`${m.role}:`)
    if (typeof m.content === 'string') {
      parts.push(m.content)
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push(String(block.text ?? ''))
      } else if (block.type === 'tool_use') {
        parts.push(
          `${String(block.name ?? '')}(${JSON.stringify(block.input ?? {})})`,
        )
      } else if (block.type === 'tool_result') {
        const content = block.content
        if (typeof content === 'string') parts.push(content)
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (c && typeof c === 'object' && 'text' in c) {
              parts.push(String(c.text ?? ''))
            }
          }
        }
      } else if (block.type === 'thinking') {
        parts.push(String(block.thinking ?? ''))
      }
    }
  }
  return parts.join('\n')
}
