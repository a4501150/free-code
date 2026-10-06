// The runtime behind a RunCode script. Each imported catalog function routes
// through invoke(), which dispatches through runToolUse — the same pipeline a
// direct tool call goes through — so inner-tool permission rules
// (mcp__server__tool etc.), PreToolUse/PostToolUse hooks, and progress
// reporting all apply unchanged. The tool_use / tool_result messages are
// forwarded as runcode_progress so the UI renders nested rows identical to
// direct calls; the script sees promise results, not messages.

import { randomUUID } from 'crypto'
import {
  findToolByName,
  type CanUseToolFn,
  type Tool,
  type ToolUseContext,
} from '../../Tool.js'
import type { DomainToolUseBlock } from '../../types/domain.js'
import type { Message } from '../../types/message.js'
import type { RunCodeProgress, ToolProgressData } from '../../types/tools.js'
import { runToolUse } from '../../services/tools/toolExecution.js'
import {
  isToolExposedToModel,
  RUN_CODE_TOOL_NAME,
} from '../../services/toolCatalog/exposure.js'
import { catalogExportName } from '../../services/toolCatalog/writer.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { stripStrictNullInputs } from '../../utils/stripStrictNullInputs.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import type { NamespaceResolution } from './loader.js'

export type RunCodeSegment = {
  name: string
  ok: boolean
  output?: string
  error?: string
}

const MAX_SEGMENT_CHARS = 20_000

function truncate(text: string): string {
  if (text.length <= MAX_SEGMENT_CHARS) return text
  return `${text.slice(0, MAX_SEGMENT_CHARS)}\n… [truncated]`
}

function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => {
      if (typeof b === 'object' && b !== null && 'type' in b) {
        const block = b as { type: string; text?: unknown }
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text
        }
        if (block.type === 'image') return '[image]'
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function innerInputSchema(tool: Tool): Record<string, unknown> | null {
  try {
    return (tool.inputJSONSchema ??
      zodToJsonSchema(tool.inputSchema as never)) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractToolResult(
  message: Message,
): { isError: boolean; text: string } | null {
  if (message.type !== 'user') return null
  const content = (message as { message?: { content?: unknown } }).message
    ?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_result'
    ) {
      const b = block as { is_error?: boolean; content?: unknown }
      return {
        isError: b.is_error === true,
        text: flattenResultContent(b.content),
      }
    }
  }
  return null
}

export type RunCodeBridge = {
  /** Backs freecode.invoke and every imported catalog function. */
  invoke(name: string, args: Record<string, unknown>): Promise<string>
  /** Backs the loader's import specifier resolution. */
  resolveNamespace: (spec: string) => NamespaceResolution
  segments: RunCodeSegment[]
}

export function createRunCodeBridge(opts: {
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  parentMessage: Parameters<CanUseToolFn>[3]
  emitProgress: (data: ToolProgressData) => void
}): RunCodeBridge {
  const { toolUseContext, canUseTool, parentMessage, emitProgress } = opts
  const segments: RunCodeSegment[] = []
  const namespaces = new Map<string, NamespaceResolution>()
  const signal = toolUseContext.abortController.signal
  let counter = 0

  const catalogedTools = () =>
    toolUseContext.options.tools.filter(t => !isToolExposedToModel(t))

  const serversWithTools = (): Map<string, Tool[]> => {
    const byServer = new Map<string, Tool[]>()
    for (const t of catalogedTools()) {
      if (!t.isMcp || !t.mcpInfo) continue
      const list = byServer.get(t.mcpInfo.serverName) ?? []
      list.push(t)
      byServer.set(t.mcpInfo.serverName, list)
    }
    return byServer
  }

  const lazyBuiltins = (): Tool[] => {
    const lazy = getSettings_DEPRECATED()?.lazyTools
    if (!Array.isArray(lazy)) return []
    const names = new Set(lazy)
    return catalogedTools().filter(t => !t.isMcp && names.has(t.name))
  }

  async function invoke(
    name: string,
    rawArgs: Record<string, unknown>,
  ): Promise<string> {
    if (signal.aborted) throw new Error('Script interrupted.')
    const tool = findToolByName(toolUseContext.options.tools, name)
    if (!tool) {
      throw new Error(
        `No such tool available: ${name}. Check the tool catalog for exact names.`,
      )
    }
    if (isToolExposedToModel(tool) || tool.name === RUN_CODE_TOOL_NAME) {
      throw new Error(
        `${name} is already directly available in your tool list; call it directly, not from the script.`,
      )
    }
    const args = (stripStrictNullInputs(
      innerInputSchema(tool) ?? {},
      rawArgs ?? {},
    ) ?? {}) as Record<string, unknown>

    const childId = `runcode_${++counter}_${randomUUID().slice(0, 8)}`
    const toolUse: DomainToolUseBlock = {
      type: 'tool_use',
      id: childId,
      name,
      input: args,
    }
    // The row for this call, ahead of its result — mirrors how the loop
    // shows a tool_use before its tool_result arrives.
    emitProgress({
      type: 'runcode_progress',
      // createAssistantMessage types content as the general array; the
      // normalized variant requires the non-empty tuple we just built.
      message: createAssistantMessage({
        content: [toolUse],
      }) as RunCodeProgress['message'],
    } satisfies RunCodeProgress)

    let result: { isError: boolean; text: string } | null = null
    let resultMessage: Message | null = null
    for await (const update of runToolUse(
      toolUse,
      parentMessage,
      canUseTool,
      toolUseContext,
    )) {
      const message = update.message as Message
      if (message.type === 'progress') {
        // Inner progress data may carry HookProgress, which lives outside
        // the tool-progress union and must not be forwarded to the UI row.
        const data = (message as { data?: { type?: string } }).data
        if (data && data.type !== 'hook_progress') {
          emitProgress(data as ToolProgressData)
        }
        continue
      }
      const extracted = extractToolResult(message)
      if (extracted) {
        result = extracted
        resultMessage = message
      }
    }

    if (!result) {
      result = { isError: true, text: `No result from ${name}.` }
    }
    const segment: RunCodeSegment = result.isError
      ? { name, ok: false, error: truncate(result.text) }
      : { name, ok: true, output: truncate(result.text) }
    segments.push(segment)
    if (resultMessage) {
      emitProgress({
        type: 'runcode_progress',
        message: resultMessage as RunCodeProgress['message'],
      } satisfies RunCodeProgress)
    }
    if (result.isError) {
      throw new Error(`${name}: ${truncate(result.text)}`)
    }
    return result.text
  }

  function resolveNamespace(spec: string): NamespaceResolution {
    const cached = namespaces.get(spec)
    if (cached) return cached
    const resolution = computeNamespace(spec)
    namespaces.set(spec, resolution)
    return resolution
  }

  function computeNamespace(spec: string): NamespaceResolution {
    let tools: Tool[]
    let exportOf: (t: Tool) => string
    if (spec === 'freecode:builtins') {
      tools = lazyBuiltins()
      exportOf = t => catalogExportName(t.name)
      if (tools.length === 0) {
        return {
          ok: false,
          error:
            'No lazily-exposed built-in tools are configured (see the lazyTools setting).',
        }
      }
    } else if (spec.startsWith('mcp/')) {
      const serverName = spec.slice('mcp/'.length)
      const server = serversWithTools().get(serverName)
      if (!server || server.length === 0) {
        const names = [...serversWithTools().keys()].sort()
        return {
          ok: false,
          error: `No cataloged tools for MCP server "${serverName}".${
            names.length > 0
              ? ` Servers with cataloged tools: ${names.join(', ')}.`
              : ' No MCP servers are cataloged.'
          }`,
        }
      }
      tools = server
      exportOf = t => catalogExportName(t.name, serverName)
    } else {
      return {
        ok: false,
        error: `Unsupported import specifier "${spec}". Use "mcp/<server>" from the tool catalog or "freecode:builtins".`,
      }
    }
    const ns: Record<string, unknown> = {}
    const exports: string[] = []
    for (const tool of tools) {
      const exported = exportOf(tool)
      if (!(exported in ns)) exports.push(exported)
      ns[exported] = (args: Record<string, unknown> = {}) =>
        invoke(tool.name, args ?? {})
    }
    return { ok: true, ns, exports }
  }

  return { invoke, resolveNamespace, segments }
}
