/**
 * Structured MCP transport bridge.
 *
 * This file implements a transport bridge that allows MCP servers running in a
 * structured host process to communicate with the Claude Code CLI process
 * through control messages.
 *
 * ## Architecture Overview
 *
 * Unlike regular MCP servers that run as separate processes, structured MCP
 * servers run in-process within their host. This requires a transport mechanism
 * to bridge communication between:
 * - The CLI process (where the MCP client runs)
 * - The structured host process (where the MCP server runs)
 *
 * ## Message Flow
 *
 * ### CLI → structured host (via StructuredControlClientTransport)
 * 1. CLI's MCP Client calls a tool → sends JSONRPC request to StructuredControlClientTransport
 * 2. Transport wraps the message in a control request with server_name and request_id
 * 3. Control request is sent via stdout to the structured host process
 * 4. The host's StructuredIO receives the control response and routes it back to the transport
 * 5. Transport unwraps the response and returns it to the MCP Client
 *
 * ### Structured host → CLI (via StructuredControlServerTransport)
 * 1. Query receives control request with MCP message and calls transport.onmessage
 * 2. MCP server processes the message and calls transport.send() with response
 * 3. Transport calls sendMcpMessage callback with the response
 * 4. Query's callback resolves the pending promise with the response
 * 5. Query returns the response to complete the control request
 *
 * ## Key Design Points
 *
 * - StructuredControlClientTransport: StructuredIO tracks pending requests
 * - StructuredControlServerTransport: Query tracks pending requests
 * - The control request wrapper includes server_name to route to the correct server
 * - The system supports multiple structured MCP servers running simultaneously
 * - Message IDs are preserved through the entire flow for proper correlation
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Callback function to send an MCP message and get the response
 */
export type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>

/**
 * CLI-side transport for structured MCP servers.
 *
 * This transport is used in the CLI process to bridge communication between:
 * - The CLI's MCP Client (which wants to call tools on structured MCP servers)
 * - The structured host process (where the actual MCP server runs)
 *
 * It converts MCP protocol messages into control requests that can be sent
 * through stdout/stdin to the structured host process.
 */
export class StructuredControlClientTransport implements Transport {
  private isClosed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(
    private serverName: string,
    private sendMcpMessage: SendMcpMessageCallback,
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }

    // Send the message and wait for the response
    const response = await this.sendMcpMessage(this.serverName, message)

    // Pass the response back to the MCP client
    if (this.onmessage) {
      this.onmessage(response)
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    this.onclose?.()
  }
}

/**
 * Host-side transport for structured MCP servers.
 *
 * This transport is used in the structured host process to bridge communication between:
 * - Control requests coming from the CLI (via stdin)
 * - The actual MCP server running in the host process
 *
 * It acts as a simple pass-through that forwards messages to the MCP server
 * and sends responses back via a callback.
 *
 * Note: Query handles all request/response correlation and async flow.
 */
export class StructuredControlServerTransport implements Transport {
  private isClosed = false

  constructor(private sendMcpMessage: (message: JSONRPCMessage) => void) {}

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }

    // Simply pass the response back through the callback
    this.sendMcpMessage(message)
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    this.onclose?.()
  }
}
