import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    peers: z.array(
      z.object({
        pid: z.number(),
        socketPath: z.string(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ListPeersTool = buildTool({
  name: 'ListPeers',
  searchHint: 'list active Claude sessions',
  maxResultSizeChars: 50_000,
  async description() {
    return 'List active Claude Code sessions on this machine'
  },
  async prompt() {
    return 'List active Claude Code peer sessions reachable via UDS messaging. Returns socket paths that can be used as SendMessage targets.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ListPeers'
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
      data: { peers: [] },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
