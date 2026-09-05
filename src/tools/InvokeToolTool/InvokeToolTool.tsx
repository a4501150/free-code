// Generic dispatcher for tools the model cannot see in the API tools array:
// MCP tools (always) and built-ins named in the `lazyTools` setting. The
// model discovers their schemas in <config-home>/tool-catalog/ and invokes
// them here. Permissions are evaluated against the INNER tool so existing
// `mcp__server__tool` rules keep working unchanged.

import { z } from 'zod/v4'
import {
  buildTool,
  type Tool,
  type ToolDef,
  type ToolUseContext,
} from '../../Tool.js'
import { getToolNameForPermissionCheck } from '../../services/mcp/mcpStringUtils.js'
import { Text } from '../../ink.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from '../../utils/permissions/permissions.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'

const inputSchema = z.object({
  tool: z
    .string()
    .describe(
      'Exact tool name from the tool catalog (e.g. "mcp__server__tool").',
    ),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arguments object matching the tool input schema.'),
})
type InputSchema = typeof inputSchema
type InvokeInput = z.infer<InputSchema>

const outputSchema = z.union([z.string(), z.array(z.any())])
type OutputSchema = typeof outputSchema
type Output = z.infer<OutputSchema>

export const INVOKE_TOOL_NAME = 'InvokeTool'

function isLazyBuiltIn(name: string): boolean {
  const lazy = getSettings_DEPRECATED()?.lazyTools
  return Array.isArray(lazy) && lazy.includes(name)
}

// A tool is directly callable when the model can already see its schema in
// the request: every built-in unless lazyTools names it. MCP tools are never
// directly callable once the catalog switch is on, but dispatch to them is
// always accepted so the dispatcher works before and after the switch.
function isDirectlyCallable(tool: Tool): boolean {
  return !tool.isMcp && !isLazyBuiltIn(tool.name)
}

type Target = { ok: true; tool: Tool } | { ok: false; error: string }

function resolveTarget(context: ToolUseContext, name: string): Target {
  const tool = context.options.tools.find(t => t.name === name)
  if (!tool) {
    return {
      ok: false,
      error: `Unknown tool "${name}". Check the tool catalog manifest (${process.env.FREECODE_CONFIG_DIR ?? '~/.freecode'}/tool-catalog/manifest.json) for exact names.`,
    }
  }
  if (isDirectlyCallable(tool)) {
    return {
      ok: false,
      error: `${name} is already directly available in your tool list.`,
    }
  }
  return { ok: true, tool }
}

function innerInputSchema(tool: Tool): Record<string, unknown> | null {
  try {
    return (tool.inputJSONSchema ??
      zodToJsonSchema(tool.inputSchema as never)) as Record<string, unknown>
  } catch {
    return null
  }
}

function requiredKeysError(input: InvokeInput, tool: Tool): string | null {
  const schema = innerInputSchema(tool)
  if (!schema) return null
  const required = schema.required
  if (!Array.isArray(required) || required.length === 0) return null
  const args = (input.args ?? {}) as Record<string, unknown>
  const missing = required.filter(
    key => typeof key === 'string' && args[key] === undefined,
  )
  if (missing.length === 0) return null
  return `Missing required argument(s) for ${tool.name}: ${missing.join(', ')}. Re-read the tool's schema in the catalog before calling it again.`
}

export const InvokeTool = buildTool({
  name: INVOKE_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return 'Call a tool that is not in your tool list'
  },
  async prompt() {
    return [
      'Call a tool that is not in your tool list. Look up the exact tool name and argument schema in the tool catalog first (~/.freecode/tool-catalog/manifest.json, then the referenced server files).',
      "The inner tool's own permission rules apply unchanged: an earlier rule that allowed or denied the inner tool still applies.",
    ].join('\n')
  },
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  async validateInput(input, context) {
    const target = resolveTarget(context as ToolUseContext, input.tool)
    if (!target.ok) {
      return { result: false, message: target.error, errorCode: 1 }
    }
    const required = requiredKeysError(input, target.tool)
    if (required) {
      return { result: false, message: required, errorCode: 2 }
    }
    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    const target = resolveTarget(context, input.tool)
    if (!target.ok) {
      return {
        behavior: 'deny',
        decisionReason: { type: 'other', reason: 'tool-not-in-catalog' },
        message: target.error,
      }
    }
    const tool = target.tool
    const view = {
      name: tool.name,
      mcpInfo: tool.mcpInfo,
    }
    const permissionContext = context.getAppState().toolPermissionContext

    const denyRule = getDenyRuleForTool(permissionContext, view)
    if (denyRule) {
      return {
        behavior: 'deny',
        decisionReason: { type: 'rule', rule: denyRule },
        message: `Permission to use ${getToolNameForPermissionCheck(view)} has been denied.`,
      }
    }

    const askRule = getAskRuleForTool(permissionContext, view)
    if (askRule) {
      return {
        behavior: 'ask',
        decisionReason: { type: 'rule', rule: askRule },
        message: `Permission requested for ${getToolNameForPermissionCheck(view)}.`,
      }
    }

    // The inner tool's own gate (MCP wrappers return passthrough with a
    // rule suggestion carrying the real inner name; lazy built-ins may
    // return content-specific decisions).
    let inner: PermissionResult
    try {
      inner = await tool.checkPermissions((input.args ?? {}) as never, context)
    } catch {
      inner = {
        behavior: 'passthrough',
        message: `Permission requested for ${tool.name}.`,
      }
    }
    if (inner.behavior !== 'passthrough') {
      return inner
    }

    // Previously-allowed inner rules auto-allow the dispatch.
    const allowRule = toolAlwaysAllowedRule(permissionContext, view)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: allowRule },
      }
    }

    return inner
  },
  toAutoClassifierInput(input) {
    return `${input.tool} ${JSON.stringify(input.args ?? {})}`.slice(0, 200)
  },
  async call(input, context, canUseTool, parentMessage, onProgress) {
    const target = resolveTarget(context, input.tool)
    if (!target.ok) {
      throw new Error(target.error)
    }
    const inner = requiredKeysError(input, target.tool)
    if (inner) {
      throw new Error(inner)
    }
    const result = await target.tool.call(
      (input.args ?? {}) as never,
      context,
      canUseTool,
      parentMessage,
      onProgress as never,
    )
    return result as never
  },
  userFacingName() {
    return INVOKE_TOOL_NAME
  },
  renderToolUseMessage(input: Partial<InvokeInput>) {
    if (!input.tool) return ''
    const args = input.args
    const argText =
      args && Object.keys(args).length > 0
        ? ` ${JSON.stringify(args).slice(0, 120)}`
        : ''
    return <Text>{`${input.tool}${argText}`}</Text>
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
