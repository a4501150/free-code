import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    workflow: z.string().describe('The workflow to run'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({ started: z.boolean() }))
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'run a workflow script',
  maxResultSizeChars: 50_000,
  async description() {
    return 'Run a workflow script'
  },
  async prompt() {
    return 'Execute a multi-step workflow script with task tracking.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Workflow'
  },
  // call() is a stub returning {started: false} — bundled/index.ts is
  // also a stub ("real implementation is not available in this build").
  // Keep the wiring intact for when the real workflow runtime lands;
  // hide the tool from the model in the meantime so it doesn't ship
  // visible-but-broken.
  isEnabled() {
    return false
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    return {
      data: { started: false },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
