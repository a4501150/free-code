import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    artifact: z.string().describe('The artifact to review'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({ reviewed: z.boolean() }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const ReviewArtifactTool = buildTool({
  name: 'ReviewArtifact',
  searchHint: 'review code artifact',
  maxResultSizeChars: 50_000,
  async description() {
    return 'Review a code artifact'
  },
  async prompt() {
    return 'Review and audit a code artifact for quality and correctness.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ReviewArtifact'
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
      data: { reviewed: false },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
