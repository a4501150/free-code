/**
 * Unit tests: tool catalog writer + mcp_tools_delta reminder.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Tool } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import {
  getMcpToolsDeltaAttachment,
  type Attachment,
} from '../../src/utils/attachments.js'
import { writeToolCatalog } from '../../src/services/toolCatalog/writer.js'
import type { ToolUseContext } from '../../src/Tool.js'

function fakeMcpTool(name: string, server: string): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: server, toolName: name.slice(server.length + 3) },
    inputJSONSchema: { type: 'object', properties: {} },
    prompt: async () => `description of ${name}`,
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  } as unknown as Tool
}

function makeContext(tools: Tool[]): ToolUseContext {
  return {
    options: { tools, mcpClients: [] },
  } as unknown as ToolUseContext
}

function attachMessage(attachment: Attachment): Message {
  return {
    type: 'attachment',
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
    attachment,
  } as Message
}

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tool-catalog-test-'))
}

describe('tool catalog writer', () => {
  test('first write renders manifest and server file at generation 1', async () => {
    const dir = await freshDir()
    const result = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__srv__a', 'srv')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map([['srv', 'server instructions']]),
      catalogDir: dir,
    })
    expect(result.wrote).toBe(true)
    expect(result.manifest.generation).toBe(1)
    expect(result.manifest.servers).toEqual([
      {
        name: 'srv',
        description: 'server instructions',
        file: 'servers/srv.json',
        toolCount: 1,
        hash: result.manifest.servers[0]!.hash,
      },
    ])
    const file = await readFile(join(dir, 'servers', 'srv.json'), 'utf8')
    expect(file).toContain('mcp__srv__a')
    expect(file).toContain('description of mcp__srv__a')
  })

  test('unchanged input skips the rewrite and keeps the generation', async () => {
    const dir = await freshDir()
    const input = {
      mcpTools: [fakeMcpTool('mcp__srv__a', 'srv')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map([['srv', '']]),
      catalogDir: dir,
    }
    const first = await writeToolCatalog(input)
    const second = await writeToolCatalog(input)
    expect(second.wrote).toBe(false)
    expect(second.manifest.generation).toBe(first.manifest.generation)
  })

  test('changed tool set bumps the generation', async () => {
    const dir = await freshDir()
    const first = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__srv__a', 'srv')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
    })
    const second = await writeToolCatalog({
      mcpTools: [
        fakeMcpTool('mcp__srv__a', 'srv'),
        fakeMcpTool('mcp__srv__b', 'srv'),
      ],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
    })
    expect(second.wrote).toBe(true)
    expect(second.manifest.generation).toBe(first.manifest.generation + 1)
    expect(second.manifest.servers[0]!.toolCount).toBe(2)
  })
})

describe('mcp_tools_delta reminder', () => {
  test('first announce is silent without forceInitial', async () => {
    const dir = await freshDir()
    const ctx = makeContext([fakeMcpTool('mcp__srv__a', 'srv')])
    const atts = await getMcpToolsDeltaAttachment(ctx, [], {
      catalogDir: dir,
    })
    expect(atts).toEqual([])
  })

  test('forceInitial with no history announces every server', async () => {
    const dir = await freshDir()
    const ctx = makeContext([fakeMcpTool('mcp__srv__a', 'srv')])
    const atts = await getMcpToolsDeltaAttachment(ctx, [], {
      forceInitial: true,
      catalogDir: dir,
    })
    expect(atts.length).toBe(1)
    const att = atts[0] as Extract<Attachment, { type: 'mcp_tools_delta' }>
    expect(att.addedNames).toEqual(['srv'])
    expect(att.changedNames).toEqual([])
    expect(att.servers[0]!.toolCount).toBe(1)
  })

  test('diff against the announced snapshot reports add/remove/change', async () => {
    const dir = await freshDir()
    const announced = await getMcpToolsDeltaAttachment(
      makeContext([fakeMcpTool('mcp__srv__a', 'srv')]),
      [],
      { forceInitial: true, catalogDir: dir },
    )
    const messages = [attachMessage(announced[0] as Attachment)]

    const noChange = await getMcpToolsDeltaAttachment(
      makeContext([fakeMcpTool('mcp__srv__a', 'srv')]),
      messages,
      { catalogDir: dir },
    )
    expect(noChange).toEqual([])

    // New server added, previous server lost its only tool (stale snapshot
    // of another server counts as removed).
    const changed = await getMcpToolsDeltaAttachment(
      makeContext([
        fakeMcpTool('mcp__srv__a', 'srv'),
        fakeMcpTool('mcp__new__b', 'new'),
      ]),
      messages,
      { catalogDir: dir },
    )
    expect(changed.length).toBe(1)
    const att = changed[0] as Extract<Attachment, { type: 'mcp_tools_delta' }>
    expect(att.addedNames).toEqual(['new'])
    expect(att.removedNames).toEqual([])

    // Server gone from the pool → removed.
    const removed = await getMcpToolsDeltaAttachment(
      makeContext([fakeMcpTool('mcp__new__b', 'new')]),
      messages,
      { catalogDir: dir },
    )
    expect(removed.length).toBe(1)
    const rem = removed[0] as Extract<Attachment, { type: 'mcp_tools_delta' }>
    expect(rem.removedNames).toEqual(['srv'])
    expect(rem.addedNames).toEqual(['new'])
  })
})
