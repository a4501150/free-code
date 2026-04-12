/**
 * Bedrock Native Adapter
 *
 * Replaces @anthropic-ai/bedrock-sdk with a native fetch adapter that:
 * 1. Rewrites URLs: /v1/messages → /model/{model}/invoke-with-response-stream
 * 2. Mutates body: removes model/stream, adds anthropic_version
 * 3. Signs requests with AWS SigV4
 * 4. Deserializes AWS EventStream binary format → Anthropic SSE
 *
 * Reference: @anthropic-ai/bedrock-sdk/src/client.ts
 */

import type { ProviderConfig } from '../../utils/settings/types.js'

// ── AWS EventStream binary parsing ──────────────────────────────────
//
// AWS EventStream format: each message is a binary frame containing:
//   [total_length: u32] [headers_length: u32] [prelude_crc: u32]
//   [headers...] [payload...] [message_crc: u32]
//
// For Bedrock streaming, each message has a `:message-type` header
// ("event" or "exception") and a `:event-type` header ("chunk" for data).
// The payload is JSON containing `bytes` (base64-encoded) which decodes
// to standard Anthropic SSE event data.

function parseEventStreamMessage(buffer: Uint8Array): {
  headers: Record<string, string>
  payload: Uint8Array
} | null {
  if (buffer.length < 16) return null // minimum: 4+4+4 prelude + 4 CRC

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const totalLength = view.getUint32(0)
  const headersLength = view.getUint32(4)
  // skip prelude CRC at offset 8

  if (buffer.length < totalLength) return null

  // Parse headers (starting at offset 12)
  const headers: Record<string, string> = {}
  let offset = 12
  const headersEnd = 12 + headersLength

  while (offset < headersEnd) {
    // Header name: [name_length: u8] [name: bytes]
    const nameLen = buffer[offset]!
    offset += 1
    const name = new TextDecoder().decode(buffer.slice(offset, offset + nameLen))
    offset += nameLen

    // Header value: [type: u8] [value_length: u16] [value: bytes]
    const headerType = buffer[offset]!
    offset += 1

    if (headerType === 7) {
      // Type 7 = string
      const valueLen = view.getUint16(offset)
      offset += 2
      const value = new TextDecoder().decode(
        buffer.slice(offset, offset + valueLen),
      )
      offset += valueLen
      headers[name] = value
    } else {
      // Skip other header types (we only care about strings for Bedrock)
      break
    }
  }

  // Payload starts after headers, ends 4 bytes before total (message CRC)
  const payloadStart = 12 + headersLength
  const payloadEnd = totalLength - 4
  const payload = buffer.slice(payloadStart, payloadEnd)

  return { headers, payload }
}

/**
 * Converts an AWS EventStream binary response into an SSE text stream.
 *
 * Bedrock returns each event as a binary EventStream frame where the payload
 * is JSON `{ bytes: "<base64>" }`. The base64 decodes to Anthropic SSE event
 * text (e.g., `event: message_start\ndata: {...}\n\n`).
 */
function eventStreamToSSE(
  eventStreamBody: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      try {
        const reader = eventStreamBody.getReader()
        let buffer = new Uint8Array(0)

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          // Append to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length)
          newBuffer.set(buffer)
          newBuffer.set(value, buffer.length)
          buffer = newBuffer

          // Try to parse complete messages from the buffer
          while (buffer.length >= 12) {
            const view = new DataView(
              buffer.buffer,
              buffer.byteOffset,
              buffer.byteLength,
            )
            const totalLength = view.getUint32(0)

            if (buffer.length < totalLength) break // need more data

            const messageBytes = buffer.slice(0, totalLength)
            buffer = buffer.slice(totalLength)

            const message = parseEventStreamMessage(messageBytes)
            if (!message) continue

            const messageType = message.headers[':message-type']
            const eventType = message.headers[':event-type']

            if (messageType === 'exception') {
              // Error event — emit as SSE error
              const errorText = new TextDecoder().decode(message.payload)
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorText } })}\n\n`,
                ),
              )
              continue
            }

            if (messageType === 'event' && eventType === 'chunk') {
              // Normal data event — payload is JSON with base64-encoded bytes
              try {
                const payloadJson = JSON.parse(
                  new TextDecoder().decode(message.payload),
                )
                if (payloadJson.bytes) {
                  const decoded = atob(payloadJson.bytes)
                  controller.enqueue(encoder.encode(decoded))
                }
              } catch {
                // Skip malformed payloads
              }
            }
          }
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } })}\n\n`,
          ),
        )
      }
      controller.close()
    },
  })
}

// ── SigV4 signing ───────────────────────────────────────────────────

interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

async function signRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  region: string,
  credentials: AwsCredentials,
): Promise<Record<string, string>> {
  // Dynamic import to avoid bundling issues
  const { SignatureV4 } = await import('@smithy/signature-v4')
  const { Sha256 } = await import('@aws-crypto/sha256-js')

  const parsedUrl = new URL(url)

  const signer = new SignatureV4({
    service: 'bedrock',
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    sha256: Sha256,
  })

  const signableHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    // SigV4 needs lowercase headers; skip host (added by signer)
    const lower = k.toLowerCase()
    if (lower !== 'host') {
      signableHeaders[lower] = v
    }
  }

  const signed = await signer.sign({
    method,
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? parseInt(parsedUrl.port) : undefined,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      host: parsedUrl.host,
      ...signableHeaders,
    },
    body,
  })

  return signed.headers as Record<string, string>
}

// ── Bedrock fetch adapter ───────────────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes
 * them to AWS Bedrock, handling URL rewriting, body mutation, SigV4 signing,
 * and EventStream→SSE conversion.
 */
export function createBedrockFetch(
  config: ProviderConfig,
  getCredentials: () => Promise<AwsCredentials | null>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const region = config.auth?.aws?.region || 'us-east-1'
  const baseUrl =
    config.baseUrl ||
    `https://bedrock-runtime.${region}.amazonaws.com`

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept Anthropic API message calls
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    // Parse the Anthropic request body
    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    // Extract model and prepare Bedrock body
    const model = anthropicBody.model as string
    const isStreaming = anthropicBody.stream !== false

    // Build Bedrock-specific body: remove model/stream, add anthropic_version
    const bedrockBody = { ...anthropicBody }
    delete bedrockBody.model
    delete bedrockBody.stream

    bedrockBody.anthropic_version = 'bedrock-2023-05-31'

    // Convert anthropic-beta header to body field
    const initHeaders = init?.headers as Record<string, string> | undefined
    const betaHeader = initHeaders?.['anthropic-beta']
    if (betaHeader) {
      bedrockBody.anthropic_beta = betaHeader
        .split(',')
        .map((s: string) => s.trim())
    }

    // Build Bedrock URL
    const encodedModel = encodeURIComponent(model)
    const action = isStreaming
      ? 'invoke-with-response-stream'
      : 'invoke'
    const bedrockUrl = `${baseUrl.replace(/\/$/, '')}/model/${encodedModel}/${action}`

    const bodyStr = JSON.stringify(bedrockBody)

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: isStreaming
        ? 'application/vnd.amazon.eventstream'
        : 'application/json',
    }

    // Copy through relevant headers from the SDK
    if (initHeaders) {
      for (const key of [
        'x-app',
        'User-Agent',
        'X-Claude-Code-Session-Id',
      ]) {
        if (initHeaders[key]) {
          requestHeaders[key] = initHeaders[key]
        }
      }
    }

    // Get AWS credentials and sign the request
    const creds = await getCredentials()
    if (creds) {
      const signedHeaders = await signRequest(
        bedrockUrl,
        'POST',
        requestHeaders,
        bodyStr,
        region,
        creds,
      )
      // Merge signed headers
      Object.assign(requestHeaders, signedHeaders)
    }

    // Make the request
    const response = await globalThis.fetch(bedrockUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: bodyStr,
    })

    if (!response.ok) {
      const errorText = await response.text()
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Bedrock API error (${response.status}): ${errorText}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!isStreaming || !response.body) {
      // Non-streaming: response is standard JSON, add back model field
      const responseBody = await response.json()
      responseBody.model = model
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Streaming: convert AWS EventStream binary → SSE text
    const sseStream = eventStreamToSSE(response.body)

    return new Response(sseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}
