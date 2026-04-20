import * as React from 'react'
import { DebugToolCallPicker } from './picker.js'
import type {
  Command,
  LocalJSXCommandCall,
} from '../../types/command.js'
import {
  buildMessageLookups,
  normalizeMessages,
  type MessageLookups,
} from '../../utils/messages.js'

const MAX_RESULT_BYTES = 4096

function truncateString(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const truncated = text.slice(0, maxBytes)
  return `${truncated}\n… [truncated, ${Buffer.byteLength(text) - maxBytes} bytes omitted]`
}

export function extractToolResultText(
  lookups: MessageLookups,
  toolUseID: string,
): string {
  const resultMsg = lookups.toolResultByToolUseID.get(toolUseID)
  if (!resultMsg) return '(no result yet)'
  if (resultMsg.type !== 'user') return '(unexpected result message type)'
  const content = resultMsg.message.content
  if (typeof content === 'string') return truncateString(content, MAX_RESULT_BYTES)
  if (!Array.isArray(content)) return '(result has no content)'
  const parts: string[] = []
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    if (block.tool_use_id !== toolUseID) continue
    const inner = block.content
    if (typeof inner === 'string') {
      parts.push(inner)
    } else if (Array.isArray(inner)) {
      for (const sub of inner) {
        if (sub.type === 'text') {
          parts.push(sub.text)
        } else if (sub.type === 'image') {
          parts.push('[image]')
        }
      }
    }
  }
  return truncateString(parts.join('\n').trim() || '(empty result)', MAX_RESULT_BYTES)
}

export function buildInspectionText(
  lookups: MessageLookups,
  toolUseID: string,
): string {
  const toolUse = lookups.toolUseByToolUseID.get(toolUseID)
  if (!toolUse) {
    return `No tool call found with ID ${toolUseID}`
  }
  const hasResult = lookups.toolResultByToolUseID.has(toolUseID)
  const errored = lookups.erroredToolUseIDs.has(toolUseID)
  const status = !hasResult ? 'no result yet' : errored ? 'error' : 'ok'
  const inputJson = JSON.stringify(toolUse.input, null, 2)
  const resultText = extractToolResultText(lookups, toolUseID)
  return [
    `Tool: ${toolUse.name}`,
    `ID:   ${toolUse.id}`,
    `Status: ${status}`,
    '',
    'Input:',
    inputJson
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n'),
    '',
    'Result:',
    resultText
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n'),
    '',
    '(duration not tracked per-call in the REPL message log)',
  ].join('\n')
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const normalized = normalizeMessages(context.messages)
  const lookups = buildMessageLookups(normalized, context.messages)
  const trimmedArg = args.trim()

  if (trimmedArg && lookups.toolUseByToolUseID.has(trimmedArg)) {
    onDone(buildInspectionText(lookups, trimmedArg), { display: 'system' })
    return null
  }

  if (lookups.toolUseByToolUseID.size === 0) {
    onDone('No tool calls recorded in the current session yet.', {
      display: 'system',
    })
    return null
  }

  const handleSelect = (toolUseID: string) => {
    onDone(buildInspectionText(lookups, toolUseID), { display: 'system' })
  }
  const handleCancel = () => onDone()
  return React.createElement(DebugToolCallPicker, {
    lookups,
    onSelect: handleSelect,
    onCancel: handleCancel,
  })
}

const debugToolCall = {
  type: 'local-jsx',
  name: 'debug-tool-call',
  description: 'Inspect a tool call (input + result) from the current session',
  argumentHint: '[tool_use_id]',
  isEnabled: () => true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default debugToolCall
