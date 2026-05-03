import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import { getMcpToolsDeltaAttachment } from '../../src/utils/attachments.js'

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

function previousDelta(
  signatures: Array<{ name: string; signature: string }>,
): Message {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: '2026-05-03T00:00:00.000Z',
    attachment: {
      type: 'mcp_tools_delta',
      addedNames: signatures.map(s => s.name),
      changedNames: [],
      removedNames: [],
      signatures,
    },
  } as Message
}

describe('MCP tools delta attachment', () => {
  test('announces new MCP tools', async () => {
    const [attachment] = await getMcpToolsDeltaAttachment(
      contextWithTools([
        mcpTool('mcp__server__read', 'Read from server', {
          type: 'object',
          properties: { path: { type: 'string' } },
        }),
      ]),
      [],
    )

    expect(attachment).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: ['mcp__server__read'],
      changedNames: [],
      removedNames: [],
    })
    expect(
      attachment?.type === 'mcp_tools_delta' ? attachment.signatures : [],
    ).toHaveLength(1)
  })

  test('does not announce identical MCP tool refreshes', async () => {
    const tool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    const [first] = await getMcpToolsDeltaAttachment(
      contextWithTools([tool]),
      [],
    )
    const second = await getMcpToolsDeltaAttachment(
      contextWithTools([tool]),
      first?.type === 'mcp_tools_delta'
        ? [previousDelta(first.signatures)]
        : [],
    )

    expect(second).toEqual([])
  })

  test('announces same-name MCP schema changes', async () => {
    const firstTool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    const [first] = await getMcpToolsDeltaAttachment(
      contextWithTools([firstTool]),
      [],
    )

    const changedTool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
      },
    })
    const [changed] = await getMcpToolsDeltaAttachment(
      contextWithTools([changedTool]),
      first?.type === 'mcp_tools_delta'
        ? [previousDelta(first.signatures)]
        : [],
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
    const [first] = await getMcpToolsDeltaAttachment(
      contextWithTools([tool]),
      [],
    )

    const [removed] = await getMcpToolsDeltaAttachment(
      contextWithTools([]),
      first?.type === 'mcp_tools_delta'
        ? [previousDelta(first.signatures)]
        : [],
    )

    expect(removed).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: [],
      changedNames: [],
      removedNames: ['mcp__server__read'],
      signatures: [],
    })
  })
})
