import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import type { Attachment, Message } from '../../src/types/message.js'
import { getMcpToolsDeltaAttachment } from '../../src/utils/attachments.js'

let catalogDir: string
// Harness state lives outside the model-facing catalog dir; keep tests off
// the real ~/.freecode/tool-catalog.json.
let statePath: string
let projectDir: string
let projectStatePath: string

function mcpTool(
  name: string,
  description: string,
  inputJSONSchema: Record<string, unknown>,
  server = 'server',
): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: server, toolName: name },
    inputJSONSchema,
    async prompt() {
      return description
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
  } as Tool
}

function fakeClient(name: string, scope: string): MCPServerConnection {
  return {
    name,
    type: 'pending',
    config: { scope },
  } as unknown as MCPServerConnection
}

function contextWithTools(
  tools: Tool[],
  clients: MCPServerConnection[] = [],
): ToolUseContext {
  return {
    options: {
      tools,
      mcpClients: clients,
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
  clients: MCPServerConnection[] = [],
) {
  return getMcpToolsDeltaAttachment(
    contextWithTools(tools, clients),
    messages,
    {
      catalogDir,
      statePath,
      projectCatalogDir: projectDir,
      projectStatePath: projectStatePath,
    },
  )
}

describe('MCP tools delta attachment', () => {
  beforeEach(async () => {
    catalogDir = await mkdtemp(join(tmpdir(), 'mcp-delta-test-'))
    statePath = `${catalogDir}-state.json`
    projectDir = await mkdtemp(join(tmpdir(), 'mcp-delta-project-test-'))
    projectStatePath = `${projectDir}-state.json`
  })

  test('initial announcement is the full catalog', async () => {
    const result = await announce([
      mcpTool('mcp__server__read', 'Read from server', {
        type: 'object',
        properties: { path: { type: 'string' } },
      }),
    ])

    expect(result.length).toBe(1)
    const att = result[0] as Record<string, unknown>
    expect(att.addedNames).toEqual(['server'])
    expect(att.changedNames).toEqual([])
    expect(att.removedNames).toEqual([])
    const servers = att.servers as Array<{ file: string }>
    expect(servers[0]!.file).toBe('servers/server.ts')
  })

  test('does not announce identical MCP tool refreshes', async () => {
    const tool = mcpTool('mcp__server__read', 'Read from server', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    // First call: full announce becomes the diff baseline
    const [baseline] = await announce([tool])
    // Second call: same tools, no delta
    const second = await announce([tool], [attachMessage(baseline!)])

    expect(second).toEqual([])
  })

  test('announces same-server schema changes', async () => {
    // First call: full announce becomes the diff baseline
    const [baseline] = await announce([
      mcpTool('mcp__server__read', 'Read from server', {
        type: 'object',
        properties: { path: { type: 'string' } },
      }),
    ])

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
    // First call: full announce becomes the diff baseline
    const [baseline] = await announce([tool])

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
    // First call: full announce with tool1 becomes the diff baseline
    const [baseline] = await announce([tool1])

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

  test('project-scope servers render into the project catalog', async () => {
    const userTool = mcpTool(
      'mcp__slack__send',
      'Send',
      {
        type: 'object',
        properties: {},
      },
      'slack',
    )
    const projectTool = mcpTool(
      'mcp__oliver__list',
      'List',
      {
        type: 'object',
        properties: {},
      },
      'oliver',
    )
    const clients = [
      fakeClient('slack', 'user'),
      fakeClient('oliver', 'project'),
    ]

    const [announce1] = await announce([userTool, projectTool], [], clients)

    expect(announce1).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: ['oliver', 'slack'],
      removedNames: [],
    })
    const servers = (
      announce1 as { servers: Array<{ name: string; catalog: string }> }
    ).servers
    const byName = new Map(servers.map(s => [s.name, s]))
    expect(byName.get('slack')!.catalog).toBe('user')
    expect(byName.get('oliver')!.catalog).toBe('project')

    // Each server's declarations file lives only in its own catalog dir.
    expect(await readdir(join(catalogDir, 'servers'))).toEqual(['slack.ts'])
    expect(await readdir(join(projectDir, 'servers'))).toEqual(['oliver.ts'])
  })

  test('a disconnected project server is announced removed but its file persists', async () => {
    const projectTool = mcpTool(
      'mcp__oliver__list',
      'List',
      {
        type: 'object',
        properties: {},
      },
      'oliver',
    )
    const clients = [fakeClient('oliver', 'project')]
    const [baseline] = await announce([projectTool], [], clients)

    // Oliver drops out of the pool (connection lost) but stays configured
    // in this session: announced removed, file kept for the reconnect.
    const [removed] = await announce([], [attachMessage(baseline!)], clients)

    expect(removed).toMatchObject({
      type: 'mcp_tools_delta',
      addedNames: [],
      changedNames: [],
      removedNames: ['oliver'],
    })
    expect(await readdir(join(projectDir, 'servers'))).toEqual(['oliver.ts'])
    // The union manifest entry survives, verified byte-identical.
    const state = JSON.parse(await readFile(projectStatePath, 'utf8')) as {
      servers: Array<{ name: string }>
    }
    expect(state.servers.map(s => s.name)).toEqual(['oliver'])
  })
})
