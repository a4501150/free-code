// Rendering for the InvokeTool dispatcher. When the inner tool defines a
// renderer, the pipeline calls it directly through unwrapInnerCall; what
// lives here is the unwrap itself plus the fallback the wrapper owns.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { findToolByName, type Tool, type Tools } from '../../Tool.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { isToolExposedToModel } from '../../services/toolCatalog/exposure.js'
import { renderToolResultMessage as renderMcpToolResultMessage } from '../MCPTool/UI.js'
import type { MCPToolResult } from '../../utils/mcpValidation.js'
import type { DomainToolResultBlockParam } from '../../types/domain.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ToolProgressData } from '../../Tool.js'

export const INVOKE_LABEL = '(Invoke)'

// Non-verbose arg slice on the error header; matches the tool-use card.
const MAX_ERROR_ARGS_CHARS = 120

type OuterInput = { tool?: unknown; args?: unknown }

export function unwrapInnerCall(
  input: unknown,
  tools: Tools,
): { tool: Tool; input: unknown; label: string } | null {
  const outer = input as OuterInput | undefined
  if (!outer || typeof outer.tool !== 'string') return null
  const inner = findToolByName(tools, outer.tool)
  if (!inner || isToolExposedToModel(inner)) return null
  const innerArgs = outer.args ?? {}
  // Args that fail the inner schema keep the raw dispatcher view — the same
  // contract the tool-use card had when it special-cased InvokeTool.
  if (!inner.inputSchema.safeParse(innerArgs).success) return null
  return { tool: inner, input: innerArgs, label: INVOKE_LABEL }
}

export function renderToolResultMessage(
  content: string | unknown[],
  progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  options: { verbose: boolean; tools: Tools; input?: unknown },
): React.ReactNode {
  // The pipeline routes renderer-having inner tools straight to their own
  // output. This runs for renderer-less inner tools and for inner tools that
  // vanished from the catalog; InvokeTool's outputSchema is MCP's
  // string | content[] union, so the MCP renderer covers both.
  const inner = unwrapInnerCall(options.input, options.tools)
  return renderMcpToolResultMessage(
    content as string | MCPToolResult,
    progressMessagesForMessage,
    { verbose: options.verbose, input: inner?.input },
  )
}

export function renderToolUseErrorMessage(
  result: DomainToolResultBlockParam['content'],
  options: { verbose: boolean; tools: Tools; input?: unknown },
): React.ReactNode {
  // An outer failure loses the inner call without this header: the raw
  // tool_use input is the only place the target name and args survive.
  const outer = options.input as OuterInput | undefined
  const inner = unwrapInnerCall(options.input, options.tools)
  const name = inner
    ? inner.tool.userFacingName(inner.input as never)
    : typeof outer?.tool === 'string'
      ? outer.tool
      : null
  const args = inner ? inner.input : outer?.args
  const argText =
    args && typeof args === 'object' && Object.keys(args).length > 0
      ? ` ${JSON.stringify(args).slice(0, MAX_ERROR_ARGS_CHARS)}`
      : ''
  return (
    <Box flexDirection="column">
      {name !== null && (
        <MessageResponse height={1}>
          <Text dimColor>{`${INVOKE_LABEL} ${name}${argText}`}</Text>
        </MessageResponse>
      )}
      <FallbackToolUseErrorMessage result={result} verbose={options.verbose} />
    </Box>
  )
}

function textOf(output: string | unknown[]): string {
  if (typeof output === 'string') return output
  return output
    .filter(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        'type' in b &&
        b.type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map(b => b.text)
    .join('\n')
}

export function isResultTruncated(output: string | unknown[]): boolean {
  return isOutputLineTruncated(textOf(output))
}

export function extractSearchText(output: string | unknown[]): string {
  return textOf(output)
}
