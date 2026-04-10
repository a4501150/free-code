import { spawnSync } from 'child_process'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTerminalPanelSocket } from '../../utils/terminalPanel.js'
import { TERMINAL_CAPTURE_TOOL_NAME, DESCRIPTION } from './prompt.js'

const TMUX_SESSION = 'panel'

const inputSchema = lazySchema(() =>
  z.strictObject({
    lines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Number of recent lines to capture. Defaults to all visible lines in the pane.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    content: z.string().describe('Captured terminal output'),
    hasSession: z.boolean().describe('Whether a terminal panel session exists'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TerminalCaptureTool = buildTool({
  name: TERMINAL_CAPTURE_TOOL_NAME,
  searchHint: 'read terminal panel shell output',
  maxResultSizeChars: 200_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  async call({ lines }) {
    const socket = getTerminalPanelSocket()

    // Check if the tmux session exists
    const hasResult = spawnSync(
      'tmux',
      ['-L', socket, 'has-session', '-t', TMUX_SESSION],
      { encoding: 'utf-8' },
    )

    if (hasResult.status !== 0) {
      return {
        data: {
          content:
            'No terminal panel session is running. The user can start one with Meta+J.',
          hasSession: false,
        },
      }
    }

    // Capture pane content
    const captureArgs = ['-L', socket, 'capture-pane', '-t', TMUX_SESSION, '-p']

    // If lines specified, use -S to start from N lines back
    if (lines !== undefined) {
      captureArgs.push('-S', `-${lines}`)
    }

    const captureResult = spawnSync('tmux', captureArgs, { encoding: 'utf-8' })

    if (captureResult.status !== 0) {
      return {
        data: {
          content: `Failed to capture terminal output: ${captureResult.stderr}`,
          hasSession: true,
        },
      }
    }

    return {
      data: {
        content: captureResult.stdout || '(terminal is empty)',
        hasSession: true,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
