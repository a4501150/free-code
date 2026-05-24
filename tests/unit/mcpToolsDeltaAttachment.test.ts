import { beforeEach, describe, expect, test } from 'bun:test'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import {
  getMcpToolsDeltaAttachment,
  resetAnnouncedMcpToolSignatures,
} from '../../src/utils/attachments.js'

function mcpTool(
  name: string,
  description: string,
  inputJSONSchema: Record<string, unknown>,
): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: 'server', toolName: name },
    inputJSONSchema,
    async prompt() {
      return description
    },
  } as Tool
}

function contextWithTools(tools: Tool[]): ToolUseContext {
  return {
    options: {
      tools,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => ({ toolPermissionContext: {} }),
  } as ToolUseContext
}

describe('MCP tools delta attachment', () => {
  beforeEach(() => {
    resetAnnouncedMcpToolSignatures()
  })

  test('suppresses initial MCP tool announcement (names already in tool definitions)', async () => {
    const result = await getMcpToolsDeltaAttachment(
      contextWithTools([
        mcpTool('mcp__server__read', 'Read from server', {
          type: 'object',
          properties: { path: { type: 'string' } },
        }),
      ]),
    )

    expect(result).toEqual([])
  })

  test('does not announce identical MCP tool refreshes', async () => {
    const tool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: records baseline
    await getMcpToolsDeltaAttachment(contextWithTools([tool]))
    // Second call: same tools, no delta
    const second = await getMcpToolsDeltaAttachment(contextWithTools([tool]))

    expect(second).toEqual([])
  })

  test('announces same-name MCP schema changes', async () => {
    const firstTool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: records baseline
    await getMcpToolsDeltaAttachment(contextWithTools([firstTool]))

    const changedTool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
      },
    })
    const [changed] = await getMcpToolsDeltaAttachment(
      contextWithTools([changedTool]),
    )

    expect(changed).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: [],
      changedNames: ['mcp__server__read'],
      removedNames: [],
    })
  })

  test('announces removed MCP tools', async () => {
    const tool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: records baseline
    await getMcpToolsDeltaAttachment(contextWithTools([tool]))

    const [removed] = await getMcpToolsDeltaAttachment(contextWithTools([]))

    expect(removed).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: [],
      changedNames: [],
      removedNames: ['mcp__server__read'],
      signatures: [],
    })
  })

  test('announces newly added MCP tools after baseline', async () => {
    const tool1 = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: records baseline with tool1
    await getMcpToolsDeltaAttachment(contextWithTools([tool1]))

    const tool2 = mcpTool('mcp__server__write', 'Write to server', {
      type: 'object',
      properties: { data: { type: 'string' } },
    })
    // Second call: tool2 added
    const [added] = await getMcpToolsDeltaAttachment(
      contextWithTools([tool1, tool2]),
    )

    expect(added).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: ['mcp__server__write'],
      changedNames: [],
      removedNames: [],
    })
  })
})
