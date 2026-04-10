/**
 * Fixture Builders
 *
 * Convenience functions for constructing MockResponse objects
 * used by integration tests.
 */

import type {
  MockResponse,
  MockSuccessResponse,
  MockContentBlock,
  MockToolUseContent,
} from './sse-encoder'

let toolIdCounter = 0

export function resetToolIdCounter(): void {
  toolIdCounter = 0
}

function nextToolId(): string {
  return `toolu_test_${String(++toolIdCounter).padStart(4, '0')}`
}

/**
 * Simple text-only response with stop_reason: "end_turn"
 */
export function textResponse(
  text: string,
  opts?: Partial<MockSuccessResponse>,
): MockResponse {
  return {
    kind: 'success',
    response: {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      ...opts,
    },
  }
}

/**
 * Response with one or more tool_use blocks.
 * stop_reason defaults to "tool_use".
 * Optionally include a text block before the tool calls.
 */
export function toolUseResponse(
  tools: Array<{
    name: string
    id?: string
    input: Record<string, unknown>
  }>,
  textBefore?: string,
): MockResponse {
  const content: MockContentBlock[] = []

  if (textBefore) {
    content.push({ type: 'text', text: textBefore })
  }

  for (const tool of tools) {
    const toolBlock: MockToolUseContent = {
      type: 'tool_use',
      id: tool.id ?? nextToolId(),
      name: tool.name,
      input: tool.input,
    }
    content.push(toolBlock)
  }

  return {
    kind: 'success',
    response: {
      content,
      stop_reason: 'tool_use',
    },
  }
}

/**
 * Response with a thinking block followed by a text block.
 */
export function thinkingResponse(
  thinking: string,
  text: string,
  signature = 'test-signature-abc123',
): MockResponse {
  return {
    kind: 'success',
    response: {
      content: [
        { type: 'thinking', thinking, signature },
        { type: 'text', text },
      ],
      stop_reason: 'end_turn',
    },
  }
}

/**
 * Response with thinking block followed by tool use.
 */
export function thinkingToolUseResponse(
  thinking: string,
  tools: Array<{
    name: string
    id?: string
    input: Record<string, unknown>
  }>,
  signature = 'test-signature-abc123',
): MockResponse {
  const content: MockContentBlock[] = [
    { type: 'thinking', thinking, signature },
  ]

  for (const tool of tools) {
    content.push({
      type: 'tool_use',
      id: tool.id ?? nextToolId(),
      name: tool.name,
      input: tool.input,
    })
  }

  return {
    kind: 'success',
    response: {
      content,
      stop_reason: 'tool_use',
    },
  }
}

/**
 * API error response.
 */
export function errorResponse(
  status: number,
  errorType: string,
  message: string,
): MockResponse {
  return {
    kind: 'error',
    status,
    errorType,
    message,
  }
}

/**
 * Text response with stop_reason: "max_tokens" (truncated output).
 */
export function maxTokensResponse(text: string): MockResponse {
  return {
    kind: 'success',
    response: {
      content: [{ type: 'text', text }],
      stop_reason: 'max_tokens',
    },
  }
}

/**
 * Raw SSE response for testing malformed/unusual server behavior.
 */
export function rawResponse(
  body: string,
  statusCode = 200,
  headers?: Record<string, string>,
): MockResponse {
  return {
    kind: 'raw',
    statusCode,
    body,
    headers,
  }
}
