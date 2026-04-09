import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({ info: z.string() }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const CtxInspectTool = buildTool({
  name: 'CtxInspect',
  searchHint: 'inspect context collapse state',
  maxResultSizeChars: 50_000,
  async description() {
    return 'Inspect the current context collapse state'
  },
  async prompt() {
    return 'Inspect context collapse archives and summaries.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'CtxInspect'
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
      data: { info: 'Context collapse is not available in this build.' },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
