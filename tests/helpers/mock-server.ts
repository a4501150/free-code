/**
 * Mock Anthropic API Server
 *
 * A Bun.serve()-based HTTP server that responds to POST /v1/messages
 * with pre-configured SSE streaming responses matching the Anthropic API format.
 */

import {
  type MockResponse,
  type MockSuccessResponse,
  encodeSuccessSSE,
  encodeErrorJSON,
  resetMessageCounter,
} from './sse-encoder'

/**
 * Encode a MockSuccessResponse as a non-streaming JSON Anthropic Message
 * (matches the body shape SDK callers get when stream:false). Used by the
 * mock when callers like sideQuery() / client.beta.messages.create() send
 * stream:false — those expect JSON, not SSE.
 */
function encodeSuccessJSON(response: MockSuccessResponse, id: string): string {
  return JSON.stringify({
    id,
    type: 'message',
    role: 'assistant',
    model: response.model ?? 'claude-sonnet-4-20250514',
    content: response.content,
    stop_reason: response.stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 100,
      output_tokens: response.usage?.output_tokens ?? 50,
      cache_creation_input_tokens:
        response.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? 0,
    },
  })
}

export interface RequestLogEntry {
  method: string
  url: string
  headers: Record<string, string>
  body: {
    model?: string
    messages?: Array<{ role: string; content: unknown }>
    system?: unknown
    tools?: unknown[]
    stream?: boolean
    max_tokens?: number
    [key: string]: unknown
  }
  timestamp: number
}

export class MockAnthropicServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private responses: MockResponse[] = []
  private requestCounter = 0
  private requestLog: RequestLogEntry[] = []
  private _port = 0
  private _url = ''

  get port(): number {
    return this._port
  }

  get url(): string {
    return this._url
  }

  async start(): Promise<{ port: number; url: string }> {
    return new Promise(resolve => {
      this.server = Bun.serve({
        port: 0, // OS-assigned
        fetch: async req => {
          return this.handleRequest(req)
        },
      })
      this._port = this.server.port
      this._url = `http://localhost:${this._port}`
      resolve({ port: this._port, url: this._url })
    })
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true)
      this.server = null
    }
  }

  reset(responses: MockResponse[]): void {
    this.responses = [...responses]
    this.requestCounter = 0
    this.requestLog = []
    resetMessageCounter()
  }

  getRequestLog(): RequestLogEntry[] {
    return [...this.requestLog]
  }

  getRequestCount(): number {
    return this.requestCounter
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // Only handle POST /v1/messages (the Anthropic SDK endpoint)
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      return this.handleMessagesRequest(req)
    }

    // Return 404 for anything else
    return new Response('Not Found', { status: 404 })
  }

  private async handleMessagesRequest(req: Request): Promise<Response> {
    // Parse and log the request body
    let body: RequestLogEntry['body'] = {}
    try {
      body = (await req.json()) as RequestLogEntry['body']
    } catch {
      // If body parsing fails, continue with empty body
    }

    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      headers[key] = value
    })

    this.requestLog.push({
      method: req.method,
      url: req.url,
      headers,
      body,
      timestamp: Date.now(),
    })

    // Get next response from queue
    const responseIndex = this.requestCounter++
    if (responseIndex >= this.responses.length) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'server_error',
            message: `Mock server: no more responses in queue (got request #${responseIndex + 1}, only ${this.responses.length} responses configured)`,
          },
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const mockResponse = this.responses[responseIndex]

    // Non-streaming callers (sideQuery / client.beta.messages.create without
    // stream:true) need JSON, not SSE. The Anthropic SDK only parses SSE when
    // the request was made in streaming mode, so always returning SSE breaks
    // these callers (the SDK throws and treats the response as unavailable).
    const isStreaming = body.stream === true

    switch (mockResponse.kind) {
      case 'success': {
        const requestId = `req_test_${String(responseIndex + 1).padStart(4, '0')}`
        if (!isStreaming) {
          const jsonBody = encodeSuccessJSON(
            mockResponse.response,
            `msg_test_${String(responseIndex + 1).padStart(4, '0')}`,
          )
          return new Response(jsonBody, {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'request-id': requestId,
            },
          })
        }
        const sseBody = encodeSuccessSSE(mockResponse.response)
        return new Response(sseBody, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'request-id': requestId,
          },
        })
      }

      case 'error': {
        const errorBody = encodeErrorJSON(
          mockResponse.errorType,
          mockResponse.message,
        )
        return new Response(errorBody, {
          status: mockResponse.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      case 'raw': {
        const rawHeaders: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          ...(mockResponse.headers ?? {}),
        }
        return new Response(mockResponse.body, {
          status: mockResponse.statusCode ?? 200,
          headers: rawHeaders,
        })
      }
    }
  }
}
