import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import {
  type CallToolResult,
  type ListToolsResult,
  type Tool as MCPTool,
} from '@modelcontextprotocol/server'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import review from '../commands/review.js'
import type { Command } from '../commands.js'
import {
  findToolByName,
  getEmptyToolPermissionContext,
  type Tool,
  type ToolUseContext,
} from '../Tool.js'
import { getTools } from '../tools.js'
import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { createAbortController } from '../utils/abortController.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { logError } from '../utils/log.js'
import { createAssistantMessage } from '../utils/messages.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { setCwd } from '../utils/Shell.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { stripStrictNullInputs } from '../utils/stripStrictNullInputs.js'
import { getErrorParts } from '../utils/toolErrors.js'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'

type ToolInput = MCPTool['inputSchema']
type ToolOutput = MCPTool['outputSchema']

export function getMCPToolInputSchema(tool: Tool): ToolInput {
  return 'inputJSONSchema' in tool && tool.inputJSONSchema
    ? (tool.inputJSONSchema as ToolInput)
    : (zodToJsonSchema(tool.modelInputSchema ?? tool.inputSchema) as ToolInput)
}

export function parseMCPToolInput(
  tool: Tool,
  args: unknown,
): Record<string, unknown> {
  const parsedInput = tool.inputSchema.safeParse(
    stripStrictNullInputs(tool.inputJSONSchema ?? tool.inputSchema, args ?? {}),
  )
  if (!parsedInput.success) {
    throw new Error(
      `Tool ${tool.name} input is invalid: ${parsedInput.error.message}`,
    )
  }
  return parsedInput.data
}

const MCP_COMMANDS: Command[] = [review]

// Connected MCP servers (from the user's config) are re-exposed through this
// server too, so `claude mcp serve` composes: an outer agent sees both the
// core tools and everything the user has configured. Connections happen
// lazily on the first tools/list or tool call and are memoized; a server
// that fails to connect degrades to its connected subset (via
// getMcpToolsCommandsAndResources reporting per-server results), never to a
// broken serve process.
type McpBridge = {
  clients: MCPServerConnection[]
  tools: Tool[]
}
let mcpBridgePromise: Promise<McpBridge> | undefined

function ensureMcpBridge(): Promise<McpBridge> {
  if (!mcpBridgePromise) {
    mcpBridgePromise = (async (): Promise<McpBridge> => {
      const bridge: McpBridge = { clients: [], tools: [] }
      await getMcpToolsCommandsAndResources(({ client, tools }) => {
        bridge.clients.push(client)
        bridge.tools.push(...tools)
      })
      return bridge
    })()
  }
  return mcpBridgePromise
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  // Use size-limited LRU cache for readFileState to prevent unbounded memory growth
  // 100 files and 25MB limit should be sufficient for MCP server operations
  const READ_FILE_STATE_CACHE_SIZE = 100
  const readFileStateCache = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )
  setCwd(cwd)
  const server = new Server(
    {
      name: 'claude/tengu',
      version: MACRO.VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => {
    const toolPermissionContext = getEmptyToolPermissionContext()
    const { tools: mcpTools } = await ensureMcpBridge()
    const tools = [...getTools(toolPermissionContext), ...mcpTools]
    return {
      tools: await Promise.all(
        tools.map(async tool => {
          let outputSchema: ToolOutput | undefined
          if (tool.outputSchema) {
            const convertedSchema = zodToJsonSchema(tool.outputSchema)
            // MCP SDK requires outputSchema to have type: "object" at root level
            // Skip schemas with anyOf/oneOf at root (from z.union, z.discriminatedUnion, etc.)
            // See: https://github.com/anthropics/claude-code/issues/8014
            if (
              typeof convertedSchema === 'object' &&
              convertedSchema !== null &&
              'type' in convertedSchema &&
              convertedSchema.type === 'object'
            ) {
              outputSchema = convertedSchema as ToolOutput
            }
          }
          return {
            ...tool,
            description: await tool.prompt({
              getToolPermissionContext: async () => toolPermissionContext,
              tools,
              agents: [],
            }),
            inputSchema: getMCPToolInputSchema(tool),
            outputSchema,
          }
        }),
      ),
    }
  })

  server.setRequestHandler(
    'tools/call',
    async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
      const toolPermissionContext = getEmptyToolPermissionContext()
      const { clients: mcpClients, tools: mcpTools } = await ensureMcpBridge()
      const tools = [...getTools(toolPermissionContext), ...mcpTools]
      const tool = findToolByName(tools, name)
      if (!tool) {
        throw new Error(`Tool ${name} not found`)
      }

      // Assume MCP servers do not read messages separately from the tool
      // call arguments.
      const toolUseContext: ToolUseContext = {
        abortController: createAbortController(),
        options: {
          commands: MCP_COMMANDS,
          tools,
          mainLoopModel: getMainLoopModel(),
          thinkingConfig: { type: 'disabled' },
          mcpClients,
          mcpResources: {},
          isNonInteractiveSession: true,
          debug,
          verbose,
          agentDefinitions: { activeAgents: [], allAgents: [] },
        },
        getAppState: () => getDefaultAppState(),
        setAppState: () => {},
        messages: [],
        readFileState: readFileStateCache,
        setInProgressToolUseIDs: () => {},
        setResponseLength: () => {},
        updateFileHistoryState: () => {},
      }

      try {
        if (!tool.isEnabled()) {
          throw new Error(`Tool ${name} is not enabled`)
        }
        const parsedInput = parseMCPToolInput(tool, args)
        const validationResult = await tool.validateInput?.(
          parsedInput,
          toolUseContext,
        )
        if (validationResult && !validationResult.result) {
          throw new Error(
            `Tool ${name} input is invalid: ${validationResult.message}`,
          )
        }
        const finalResult = await tool.call(
          parsedInput,
          toolUseContext,
          hasPermissionsToUseTool,
          createAssistantMessage({
            content: [],
          }),
        )

        return {
          content: [
            {
              type: 'text' as const,
              text:
                typeof finalResult === 'string'
                  ? finalResult
                  : jsonStringify(finalResult.data),
            },
          ],
        }
      } catch (error) {
        logError(error)

        const parts =
          error instanceof Error ? getErrorParts(error) : [String(error)]
        const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: errorText,
            },
          ],
        }
      }
    },
  )

  async function runServer() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }

  return await runServer()
}
