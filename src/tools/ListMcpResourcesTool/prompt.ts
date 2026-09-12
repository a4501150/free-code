export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'

export const DESCRIPTION = `
Lists available resources from configured MCP servers.
Each resource object includes a 'server' field indicating which server it comes from.

Usage examples:
- List all resources from all servers: call \`ListMcpResourcesTool\` with \`{}\`
- List resources from a specific server: call \`ListMcpResourcesTool\` with \`{ "server": "myserver" }\`
`

export const PROMPT = `
List available resources from configured MCP servers.
Each returned resource will include all standard MCP resource fields plus a 'server' field
indicating which server the resource belongs to.
`
