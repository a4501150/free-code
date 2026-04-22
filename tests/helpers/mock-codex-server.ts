/**
 * Mock Codex (OpenAI Responses API) Server
 *
 * A Bun.serve()-based HTTP server that responds to POST /responses
 * with Responses-API-format SSE streaming responses. Used to test the
 * codex-fetch-adapter end-to-end, including reasoning round-trip via
 * opaque `encrypted_content`.
 *
 * The adapter is wired to POST {baseUrl}/responses when baseUrl is
 * set (proxy mode), skipping JWT account extraction.
 */

export interface CodexRequestLogEntry {
  method: string
  url: string
  headers: Record<string, string>
  body: {
    model?: string
    instructions?: string
    input?: Array<Record<string, unknown>>
    include?: string[]
    store?: boolean
    stream?: boolean
    [key: string]: unknown
  }
  timestamp: number
}

export interface CodexTextResponse {
  kind: 'text'
  text: string
  model?: string
}

export interface CodexReasoningThenTextResponse {
  kind: 'reasoning_text'
  reasoningId: string
  encryptedContent: string
  reasoningText: string
  text: string
  model?: string
}

export interface CodexErrorResponse {
  kind: 'error'
  status: number
  message: string
}

export type CodexMockResponse =
  | CodexTextResponse
  | CodexReasoningThenTextResponse
  | CodexErrorResponse

function sseLines(eventType: string, data: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...data })}\n\n`
}

function encodeResponsesSSE(
  response: CodexTextResponse | CodexReasoningThenTextResponse,
): string {
  const parts: string[] = []

  if (response.kind === 'reasoning_text') {
    // 1. reasoning item added (no encrypted_content yet)
    parts.push(
      sseLines('response.output_item.added', {
        item: {
          type: 'reasoning',
          id: response.reasoningId,
          summary: [],
        },
      }),
    )
    // 2. reasoning text deltas (split to 40 char chunks)
    for (let i = 0; i < response.reasoningText.length; i += 40) {
      parts.push(
        sseLines('response.reasoning_text.delta', {
          delta: response.reasoningText.slice(i, i + 40),
        }),
      )
    }
    // 3. reasoning item done with encrypted_content
    parts.push(
      sseLines('response.output_item.done', {
        item: {
          type: 'reasoning',
          id: response.reasoningId,
          encrypted_content: response.encryptedContent,
          summary: [
            { type: 'summary_text', text: response.reasoningText },
          ],
        },
      }),
    )
  }

  // Message block for text
  const text =
    response.kind === 'text' ? response.text : response.text
  parts.push(
    sseLines('response.output_item.added', {
      item: { type: 'message' },
    }),
  )
  for (let i = 0; i < text.length; i += 40) {
    parts.push(
      sseLines('response.output_text.delta', {
        delta: text.slice(i, i + 40),
      }),
    )
  }
  parts.push(
    sseLines('response.output_item.done', {
      item: { type: 'message' },
    }),
  )

  // Completed + usage
  parts.push(
    sseLines('response.completed', {
      response: {
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
  )

  return parts.join('')
}

export class MockCodexServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private responses: CodexMockResponse[] = []
  private requestCounter = 0
  private requestLog: CodexRequestLogEntry[] = []
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
        port: 0,
        fetch: async req => this.handleRequest(req),
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

  reset(responses: CodexMockResponse[]): void {
    this.responses = [...responses]
    this.requestCounter = 0
    this.requestLog = []
  }

  getRequestLog(): CodexRequestLogEntry[] {
    return [...this.requestLog]
  }

  getRequestCount(): number {
    return this.requestCounter
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/responses') {
      return this.handleResponsesRequest(req)
    }
    return new Response('Not Found', { status: 404 })
  }

  private async handleResponsesRequest(req: Request): Promise<Response> {
    let body: CodexRequestLogEntry['body'] = {}
    try {
      body = (await req.json()) as CodexRequestLogEntry['body']
    } catch {
      /* empty body */
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

    const idx = this.requestCounter++
    if (idx >= this.responses.length) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Mock Codex server: no more responses (#${idx + 1} of ${this.responses.length})`,
            type: 'server_error',
          },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const mock = this.responses[idx]!
    if (mock.kind === 'error') {
      return new Response(
        JSON.stringify({
          error: { message: mock.message, type: 'server_error' },
        }),
        {
          status: mock.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const sseBody = encodeResponsesSSE(mock)
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
