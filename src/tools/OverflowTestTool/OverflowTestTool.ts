import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const OVERFLOW_TEST_TOOL_NAME = 'OverflowTest'

const DESCRIPTION =
  'Debug tool for testing overflow scenarios. Generates a string of the requested size to simulate large tool outputs.'

const inputSchema = lazySchema(() =>
  z.object({
    size: z.number().describe('Number of characters to generate'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output = { data: string }

export const OverflowTestTool = buildTool({
  name: OVERFLOW_TEST_TOOL_NAME,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async call(input) {
    const count = Math.max(0, Math.min(input.size, 10_000_000))
    return { data: { data: 'x'.repeat(count) } }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
} satisfies ToolDef<InputSchema, Output>)
