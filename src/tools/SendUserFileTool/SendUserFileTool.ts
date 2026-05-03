/**
 * SendUserFileTool — deliver files to the user in assistant/brief mode.
 *
 * Validates file existence, reads metadata, and presents the file to the
 * user via the tool result. Works alongside BriefTool for file delivery
 * in KAIROS assistant mode.
 */

import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isBriefEnabled } from '../BriefTool/BriefTool.js'
import {
  SEND_USER_FILE_TOOL_NAME,
  DESCRIPTION,
  SEND_USER_FILE_TOOL_PROMPT,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .describe('Path to the file to send (absolute or relative to cwd).'),
    description: z
      .string()
      .optional()
      .describe('Optional description of the file and why it is being sent.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    sent: z.boolean(),
    path: z.string(),
    size: z.number().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const SendUserFileTool = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  maxResultSizeChars: 50_000,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return SEND_USER_FILE_TOOL_PROMPT
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  userFacingName() {
    return 'SendUserFile'
  },

  isEnabled() {
    return isBriefEnabled()
  },

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  renderToolUseMessage(input, _output) {
    const desc = (input as { description?: string }).description
    const path = (input as { path?: string }).path ?? 'unknown'
    if (desc) {
      return `Sending file: ${path} — ${desc}`
    }
    return `Sending file: ${path}`
  },

  async call(input) {
    const filePath = resolve(input.path)

    if (!existsSync(filePath)) {
      return {
        data: {
          sent: false,
          path: filePath,
          error: `File not found: ${filePath}`,
        },
      }
    }

    try {
      const stats = statSync(filePath)
      if (stats.isDirectory()) {
        return {
          data: {
            sent: false,
            path: filePath,
            error: 'Path is a directory, not a file.',
          },
        }
      }

      // Report success with file metadata. The file content itself
      // is available to the LLM via FileReadTool — SendUserFileTool
      // is about signaling intent to deliver a file to the user.
      return {
        data: {
          sent: true,
          path: filePath,
          size: stats.size,
        },
      }
    } catch (err) {
      return {
        data: {
          sent: false,
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        },
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
