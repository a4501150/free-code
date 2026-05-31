import type { Tool } from '../../Tool.js'
import { stripStrictNullInputs } from '../../utils/stripStrictNullInputs.js'

export function isConcurrencySafeToolInput(
  tool: Tool | undefined,
  input: unknown,
): boolean {
  if (!tool) return false
  const parsedInput = tool.inputSchema.safeParse(
    stripStrictNullInputs(tool.inputSchema, input),
  )
  if (!parsedInput.success) return false
  try {
    return Boolean(tool.isConcurrencySafe(parsedInput.data))
  } catch {
    return false
  }
}
