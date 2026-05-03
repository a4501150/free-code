import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SNIP_TOOL_NAME, DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({ snipped: z.boolean() }))
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const SnipTool = buildTool({
  name: SNIP_TOOL_NAME,
  maxResultSizeChars: 10_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Snip'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    return {
      data: { snipped: false },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
