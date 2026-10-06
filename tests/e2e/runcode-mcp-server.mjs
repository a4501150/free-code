// Minimal stdio MCP server for the RunCode e2e: one `echo` tool. Speaks
// newline-delimited JSON-RPC (the MCP stdio framing) with just enough surface
// to complete a real client handshake.
import { createInterface } from 'readline'

const TOOL = {
  name: 'echo',
  description: 'Echo the given message back.',
  inputSchema: {
    type: 'object',
    properties: { msg: { type: 'string', description: 'Message to echo' } },
    required: ['msg'],
  },
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (req.id === undefined) return // notification
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-server', version: '1.0.0' },
        },
      })
      break
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: { tools: [TOOL] },
      })
      break
    case 'tools/call': {
      const msg = req.params?.arguments?.msg ?? ''
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: `echo:${msg}` }] },
      })
      break
    }
    case 'prompts/list':
    case 'resources/list':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: req.method === 'prompts/list' ? { prompts: [] } : { resources: [] },
      })
      break
    default:
      send({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `unknown method ${req.method}` },
      })
  }
})
