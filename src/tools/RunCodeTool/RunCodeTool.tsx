// Code-mode dispatcher: the model writes a TypeScript script against the
// generated catalog (servers/<name>.ts, builtins.ts); the script runs
// in-process and its imported catalog functions dispatch through the normal
// tool pipeline (see bridge.ts). Permissions are evaluated per bridged call
// against the INNER tool, so existing mcp__server__tool rules keep working
// unchanged; the outer tool only honors RunCode-specific deny/ask rules.

import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { Text } from '../../ink.js'
import type { DomainToolResultBlockParam } from '../../types/domain.js'
import type { ToolProgressData } from '../../types/tools.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
} from '../../utils/permissions/permissions.js'
import { RUN_CODE_TOOL_NAME } from '../../services/toolCatalog/exposure.js'
import { createRunCodeBridge } from './bridge.js'
import { runScript } from './loader.js'
import { withModuleFallback } from './moduleRegistry.js'
import {
  extractSearchText,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseProgressMessage,
} from './UI.js'

// Session-scoped object shared by every script run in this process; never
// persisted to disk and dies with the CLI process.
const persistentState: Record<string, unknown> = {}

const inputSchema = z.object({
  code: z.string().min(1),
  title: z
    .string()
    .optional()
    .describe('Short label for what the script does, shown to the user.'),
})
type InputSchema = typeof inputSchema
type Output = z.infer<typeof outputSchema>

const segmentSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
})
const outputSchema = z.object({
  segments: z.array(segmentSchema),
  logs: z.string(),
})

// toolUseResult is typed `unknown` on messages and normalizeMessages hands
// the one message-level field to every block-split, so a foreign Output can
// reach the renderers (e.g. a tool_result sharing a message with another
// tool's result). Every entry point must check the shape before field access.
export function isRunCodeOutput(output: unknown): output is Output {
  return (
    typeof output === 'object' &&
    output !== null &&
    Array.isArray((output as Output).segments) &&
    typeof (output as Output).logs === 'string'
  )
}

export function renderRunCodeResultText(output: Output): string {
  if (!isRunCodeOutput(output)) return ''
  const parts: string[] = []
  output.segments.forEach((s, i) => {
    parts.push(
      s.ok
        ? `[${i + 1}] ${s.name}\n${s.output ?? ''}`
        : `[${i + 1}] ${s.name} FAILED\n${s.error ?? ''}`,
    )
  })
  if (output.logs.length > 0) {
    parts.push(`Script output:\n${output.logs}`)
  }
  return parts.join('\n\n')
}

export const RunCodeTool = buildTool({
  name: RUN_CODE_TOOL_NAME,
  maxResultSizeChars: 100_000,
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Run a TypeScript script that calls cataloged MCP tools as functions'
  },
  async prompt() {
    return [
      `Run a TypeScript script that imports cataloged tools and orchestrates them in one execution; cataloged tools remain the normal way to act — reach for direct runtime access only when a script genuinely needs it. Each tool's declarations file is named by absolute path in the deferred_tools_delta and mcp_tools_delta system reminders: read those index files (import specifier "mcp/<server>" for server declarations, "freecode:builtins" for built-ins) for exact function names and argument types.`,
      'Every tool call from the script goes through the normal permission and hook pipeline. Await each call; console.log what you want reported — only your logs and the call results come back.',
      'A `state` object persists across RunCode calls in this session (in-memory only; write files for anything durable).',
      'Runtime access: dynamic import() resolves Node and Bun builtins (await import("node:fs")) and the bundled tooling modules; other specifiers (relative paths, arbitrary npm packages) do not resolve, and default imports in static import declarations are unsupported. The Bun, process, and fetch globals are reachable.',
    ].join('\n')
  },
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get outputSchema() {
    return outputSchema
  },
  async checkPermissions(input, context) {
    const permissionContext = context.getAppState().toolPermissionContext
    const view = { name: RUN_CODE_TOOL_NAME }
    const denyRule = getDenyRuleForTool(permissionContext, view)
    if (denyRule) {
      return {
        behavior: 'deny',
        decisionReason: { type: 'rule', rule: denyRule },
        message: `Permission to use ${RUN_CODE_TOOL_NAME} has been denied.`,
      }
    }
    const askRule = getAskRuleForTool(permissionContext, view)
    if (askRule) {
      return {
        behavior: 'ask',
        decisionReason: { type: 'rule', rule: askRule },
        message: `Permission requested for ${RUN_CODE_TOOL_NAME}.`,
      }
    }
    // Per-call inner-tool permissions gate the script; prompting again for
    // the wrapper itself would double every approval.
    return { behavior: 'allow', updatedInput: input }
  },
  async validateInput(input) {
    if (input.code.trim().length === 0) {
      return { result: false, message: 'code is empty', errorCode: 1 }
    }
    return { result: true }
  },
  toAutoClassifierInput(input) {
    return (input.title ?? input.code).slice(0, 200)
  },
  async call(input, context, canUseTool, parentMessage, onProgress) {
    let seq = 0
    const bridge = createRunCodeBridge({
      toolUseContext: context as ToolUseContext,
      canUseTool,
      parentMessage,
      emitProgress: (data: ToolProgressData) =>
        onProgress?.({ toolUseID: `runcode_emit_${++seq}`, data }),
    })
    const result = await runScript(input.code, {
      resolveNamespace: withModuleFallback(bridge.resolveNamespace),
      signal: context.abortController.signal,
      state: persistentState,
      extraGlobals: {
        freecode: {
          invoke: (name: string, args: Record<string, unknown>) =>
            bridge.invoke(name, args ?? {}),
        },
      },
    })
    if (!result.ok) {
      const tail =
        result.logs.length > 0
          ? `\nScript output before failure:\n${result.logs.join('\n')}`
          : ''
      throw new Error(`${result.error}${tail}`)
    }
    return {
      data: {
        segments: bridge.segments,
        logs: result.logs.join('\n'),
      },
    }
  },
  userFacingName() {
    return RUN_CODE_TOOL_NAME
  },
  renderToolUseMessage(input: Partial<{ code: string; title?: string }>) {
    if (!input.code) return ''
    const label =
      input.title ?? input.code.split('\n').find(l => l.trim().length > 0) ?? ''
    return <Text>{label.trim().slice(0, 80)}</Text>
  },
  renderToolUseProgressMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  isResultTruncated,
  extractSearchText,
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): DomainToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: renderRunCodeResultText(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)

export type RunCodeOutput = Output
