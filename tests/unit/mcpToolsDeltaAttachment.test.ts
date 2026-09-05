import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import type { Attachment, Message } from '../../src/types/message.js'
import { getMcpToolsDeltaAttachment } from '../../src/utils/attachments.js'

let catalogDir: string

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
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
  } as Tool
}

function contextWithTools(tools: Tool[]): ToolUseContext {
  return {
    options: {
      tools,
      mcpClients: [],
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => ({ toolPermissionContext: {} }),
  } as ToolUseContext
}

function attachMessage(attachment: Attachment): Message {
  return {
    type: 'attachment',
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
    attachment,
  } as Message
}

async function announce(
  tools: Tool[],
  messages: Message[] = [],
  forceInitial = false,
) {
  return getMcpToolsDeltaAttachment(contextWithTools(tools), messages, {
    catalogDir,
    ...(forceInitial ? { forceInitial: true } : {}),
  })
}

describe('MCP tools delta attachment', () => {
  beforeEach(async () => {
    catalogDir = await mkdtemp(join(tmpdir(), 'mcp-delta-test-'))
  })

  test('initial announcement carries an empty diff (renders silent)', async () => {
    const result = await announce([
      mcpTool('mcp__server__read', 'Read from server', {
        type: 'object',
        properties: { path: { type: 'string' } },
      }),
    ])

    expect(result.length).toBe(1)
    const att = result[0] as Record<string, unknown>
    expect(att.addedNames).toEqual([])
    expect(att.changedNames).toEqual([])
    expect(att.removedNames).toEqual([])
  })

  test('does not announce identical MCP tool refreshes', async () => {
    const tool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: records baseline
    const [baseline] = await announce([tool], [], true)
    // Second call: same tools, no delta
    const second = await announce([tool], [attachMessage(baseline!)])

    expect(second).toEqual([])
  })

  test('announces same-server schema changes', async () => {
    // First call: records baseline
    const [baseline] = await announce(
      [
        mcpTool('mcp__server__read', 'Read from server', {
          type: 'object',
          properties: { path: { type: 'string' } },
        }),
      ],
      [],
      true,
    )

    const changedTool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
      },
    })
    const [changed] = await announce([changedTool], [attachMessage(baseline!)])

    expect(changed).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: [],
      changedNames: ['server'],
      removedNames: [],
    })
  })

  test('announces a server that loses every tool', async () => {
    const tool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: records baseline
    const [baseline] = await announce([tool], [], true)

    const [removed] = await announce([], [attachMessage(baseline!)])

    expect(removed).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: [],
      changedNames: [],
      removedNames: ['server'],
    })
  })

  test('announces new servers after baseline', async () => {
    const tool1 = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: records baseline with tool1
    const [baseline] = await announce([tool1], [], true)

    const tool2: Tool = {
      ...mcpTool('mcp__other__write', 'Write to other', {
        type: 'object',
        properties: { data: { type: 'string' } },
      }),
      mcpInfo: { serverName: 'other', toolName: 'mcp__other__write' },
    }
    // Second call: second server added
    const [added] = await announce([tool1, tool2], [attachMessage(baseline!)])

    expect(added).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: ['other'],
      changedNames: [],
      removedNames: [],
    })
  })
})
