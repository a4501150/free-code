/**
 * Mock OpenAI Chat Completions Server
 *
 * A Bun.serve()-based HTTP server that responds to POST /v1/chat/completions
 * with OpenAI-format SSE streaming responses.
 *
 * Used to test the openai-chat-completions adapter end-to-end.
 */

export interface OpenAIRequestLogEntry {
  method: string
  url: string
  headers: Record<string, string>
  body: {
    model?: string
    messages?: Array<{ role: string; content: unknown }>
    tools?: unknown[]
    stream?: boolean
    max_tokens?: number
    [key: string]: unknown
  }
  timestamp: number
}

export interface OpenAITextResponse {
  kind: 'text'
  text: string
  model?: string
}

export interface OpenAIToolCallResponse {
  kind: 'tool_call'
  toolCalls: Array<{
    id: string
    name: string
    arguments: string
  }>
  textBefore?: string
  model?: string
}

export interface OpenAIErrorResponse {
  kind: 'error'
  status: number
  message: string
}

export type OpenAIMockResponse =
  | OpenAITextResponse
  | OpenAIToolCallResponse
  | OpenAIErrorResponse

let messageIdCounter = 0

function nextMessageId(): string {
  return `chatcmpl-test-${String(++messageIdCounter).padStart(4, '0')}`
}

function encodeOpenAISSE(response: OpenAITextResponse | OpenAIToolCallResponse): string {
  const id = nextMessageId()
  const model = response.model || 'test-model'
  const chunks: string[] = []

  if (response.kind === 'text') {
    // Stream the text in 50-char chunks
    const text = response.text
    for (let i = 0; i < text.length; i += 50) {
      const chunk = text.slice(i, i + 50)
      chunks.push(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          model,
          choices: [
            {
              index: 0,
              delta: { content: chunk },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      )
    }

    // Final chunk with finish_reason
    chunks.push(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      })}\n\n`,
    )
  } else if (response.kind === 'tool_call') {
    // Optional text before tool calls
    if (response.textBefore) {
      chunks.push(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          model,
          choices: [
            {
              index: 0,
              delta: { content: response.textBefore },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      )
    }

    // Tool call chunks
    for (let i = 0; i < response.toolCalls.length; i++) {
      const tc = response.toolCalls[i]!
      // First chunk: tool call start (with id and name)
      chunks.push(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      )

      // Stream arguments in chunks
      const args = tc.arguments
      for (let j = 0; j < args.length; j += 40) {
        const argChunk = args.slice(j, j + 40)
        chunks.push(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: i,
                      function: { arguments: argChunk },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        )
      }
    }

    // Final chunk with finish_reason
    chunks.push(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\n`,
    )
  }

  // Usage chunk
  chunks.push(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    })}\n\n`,
  )

  // Done
  chunks.push('data: [DONE]\n\n')

  return chunks.join('')
}

export class MockOpenAIServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private responses: OpenAIMockResponse[] = []
  private requestCounter = 0
  private requestLog: OpenAIRequestLogEntry[] = []
  private _port = 0
  private _url = ''

  get port(): number {
    return this._port
  }

  get url(): string {
    return this._url
  }

  async start(): Promise<{ port: number; url: string }> {
    return new Promise((resolve) => {
      this.server = Bun.serve({
        port: 0,
        fetch: async (req) => {
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

  reset(responses: OpenAIMockResponse[]): void {
    this.responses = [...responses]
    this.requestCounter = 0
    this.requestLog = []
    messageIdCounter = 0
  }

  getRequestLog(): OpenAIRequestLogEntry[] {
    return [...this.requestLog]
  }

  getRequestCount(): number {
    return this.requestCounter
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (
      req.method === 'POST' &&
      url.pathname === '/v1/chat/completions'
    ) {
      return this.handleCompletionsRequest(req)
    }

    return new Response('Not Found', { status: 404 })
  }

  private async handleCompletionsRequest(req: Request): Promise<Response> {
    let body: OpenAIRequestLogEntry['body'] = {}
    try {
      body = (await req.json()) as OpenAIRequestLogEntry['body']
    } catch {
      // Continue with empty body
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

    const responseIndex = this.requestCounter++
    if (responseIndex >= this.responses.length) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Mock OpenAI server: no more responses (got #${responseIndex + 1}, have ${this.responses.length})`,
            type: 'server_error',
          },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const mockResponse = this.responses[responseIndex]!

    if (mockResponse.kind === 'error') {
      return new Response(
        JSON.stringify({
          error: {
            message: mockResponse.message,
            type: 'server_error',
          },
        }),
        {
          status: mockResponse.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const sseBody = encodeOpenAISSE(mockResponse)
    return new Response(sseBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}
