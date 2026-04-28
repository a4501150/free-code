/**
 * SSE Encoder for Mock Anthropic Messages API
 *
 * Converts structured MockResponse objects into raw SSE byte streams
 * matching the Anthropic streaming API format.
 */

// --- Types ---

export type MockTextContent = {
  type: 'text'
  text: string
}

export type MockToolUseContent = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type MockThinkingContent = {
  type: 'thinking'
  thinking: string
  signature: string
}

export type MockContentBlock =
  | MockTextContent
  | MockToolUseContent
  | MockThinkingContent

export type MockSuccessResponse = {
  id?: string
  model?: string
  content: MockContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: {
    input_tokens: number
    output_tokens: number
    /**
     * Optional: input tokens written to cache this turn. When set, emitted
     * on both `message_start` and `message_delta` so downstream tests can
     * assert on statusline cache accounting. Defaults to 0 when unset.
     */
    cache_creation_input_tokens?: number
    /**
     * Optional: input tokens served from cache. Emitted on `message_start`
     * to match Anthropic's real behavior (read-from-cache is known at the
     * moment the request resolves). Defaults to 0 when unset.
     */
    cache_read_input_tokens?: number
  }
}

export type MockResponse =
  | { kind: 'success'; response: MockSuccessResponse }
  | {
      kind: 'error'
      status: number
      errorType: string
      message: string
    }
  | {
      kind: 'raw'
      statusCode?: number
      body: string
      headers?: Record<string, string>
    }

// --- Encoder ---

let messageCounter = 0

function nextMessageId(): string {
  return `msg_test_${String(++messageCounter).padStart(4, '0')}`
}

export function resetMessageCounter(): void {
  messageCounter = 0
}

function sseEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Split a string into chunks of approximately `size` characters.
 * Used to simulate realistic streaming deltas.
 */
function chunkString(str: string, size: number): string[] {
  if (str.length === 0) return ['']
  const chunks: string[] = []
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size))
  }
  return chunks
}

/**
 * Encode a MockSuccessResponse into a raw SSE string matching the
 * Anthropic Messages streaming API format.
 */
export function encodeSuccessSSE(response: MockSuccessResponse): string {
  const id = response.id ?? nextMessageId()
  const model = response.model ?? 'claude-sonnet-4-20250514'
  const inputTokens = response.usage?.input_tokens ?? 100
  const outputTokens = response.usage?.output_tokens ?? 50
  const cacheCreationInputTokens =
    response.usage?.cache_creation_input_tokens ?? 0
  const cacheReadInputTokens = response.usage?.cache_read_input_tokens ?? 0

  let sse = ''

  // 1. message_start
  sse += sseEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: cacheCreationInputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
      },
    },
  })

  // 2. For each content block
  for (let i = 0; i < response.content.length; i++) {
    const block = response.content[i]

    switch (block.type) {
      case 'text': {
        // content_block_start
        sse += sseEvent('content_block_start', {
          type: 'content_block_start',
          index: i,
          content_block: { type: 'text', text: '' },
        })

        // content_block_delta(s) - split text into chunks
        const textChunks = chunkString(block.text, 50)
        for (const chunk of textChunks) {
          sse += sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'text_delta', text: chunk },
          })
        }

        // content_block_stop
        sse += sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: i,
        })
        break
      }

      case 'tool_use': {
        // content_block_start
        sse += sseEvent('content_block_start', {
          type: 'content_block_start',
          index: i,
          content_block: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          },
        })

        // content_block_delta(s) - split JSON input into chunks
        const jsonStr = JSON.stringify(block.input)
        const jsonChunks = chunkString(jsonStr, 40)
        for (const chunk of jsonChunks) {
          sse += sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'input_json_delta', partial_json: chunk },
          })
        }

        // content_block_stop
        sse += sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: i,
        })
        break
      }

      case 'thinking': {
        // content_block_start
        sse += sseEvent('content_block_start', {
          type: 'content_block_start',
          index: i,
          content_block: { type: 'thinking', thinking: '' },
        })

        // thinking_delta(s)
        const thinkingChunks = chunkString(block.thinking, 50)
        for (const chunk of thinkingChunks) {
          sse += sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'thinking_delta', thinking: chunk },
          })
        }

        // signature_delta
        if (block.signature) {
          sse += sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'signature_delta', signature: block.signature },
          })
        }

        // content_block_stop
        sse += sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: i,
        })
        break
      }
    }
  }

  // 3. message_delta
  sse += sseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
    },
  })

  // 4. message_stop
  sse += sseEvent('message_stop', {
    type: 'message_stop',
  })

  return sse
}

/**
 * Encode an error response as a JSON body (not SSE).
 */
export function encodeErrorJSON(errorType: string, message: string): string {
  return JSON.stringify({
    type: 'error',
    error: {
      type: errorType,
      message,
    },
  })
}
