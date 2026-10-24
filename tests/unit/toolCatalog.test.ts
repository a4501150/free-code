/**
 * Unit tests: tool catalog codegen (TypeScript modules) + mcp_tools_delta
 * reminder. The harness state file lives outside the model-facing catalog
 * directory — tests keep it as a sibling of the temp catalogDir so root
 * cleanup (which removes stray .json/.ts) never touches it.
 */
import { describe, test, expect } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdtemp, readFile, writeFile, mkdir } from 'fs/promises'
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

function fakeMcpTool(
  name: string,
  server: string,
  inputJSONSchema: unknown = { type: 'object', properties: {} },
): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: server, toolName: name.slice(server.length + 3) },
    inputJSONSchema,
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

function statePathFor(dir: string): string {
  return `${dir}-state.json`
}

describe('tool catalog writer', () => {
  test('first write renders a TS server module and state at generation 1', async () => {
    const dir = await freshDir()
    const result = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__srv__a', 'srv')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map([['srv', 'server instructions']]),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    expect(result.wrote).toBe(true)
    expect(result.manifest.generation).toBe(1)
    expect(result.manifest.servers).toEqual([
      {
        name: 'srv',
        description: 'server instructions',
        file: 'servers/srv.ts',
        toolCount: 1,
        hash: result.manifest.servers[0]!.hash,
        digest: expect.any(String),
      },
    ])
    const file = await readFile(join(dir, 'servers', 'srv.ts'), 'utf8')
    // Server instructions render as the header block comment.
    expect(file).toContain('server instructions')
    // Tool renders as an exported forwarding function with its description.
    expect(file).toContain('export function a(args:')
    expect(file).toContain('description of mcp__srv__a')
    expect(file).toContain('freecode.invoke("mcp__srv__a"')
    // State is the harness file outside the model-facing directory.
    const state = JSON.parse(await readFile(statePathFor(dir), 'utf8')) as {
      generation: number
    }
    expect(state.generation).toBe(1)
  })

  test('schema emission maps required/optional, enums, arrays, and nested objects', async () => {
    const dir = await freshDir()
    await writeToolCatalog({
      mcpTools: [
        fakeMcpTool('mcp__srv__search', 'srv', {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'the search query' },
            limit: { type: 'integer' },
            mode: { enum: ['fast', 'deep'] },
            tags: { type: 'array', items: { type: 'string' } },
            when: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            filter: {
              type: 'object',
              required: ['ids'],
              properties: { ids: { type: 'array', items: { type: 'number' } } },
            },
          },
        }),
      ],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    const file = await readFile(join(dir, 'servers', 'srv.ts'), 'utf8')
    expect(file).toContain('query: string')
    expect(file).not.toContain('@default')
    expect(file).toContain('the search query')
    expect(file).toContain('limit?: number')
    expect(file).toContain('"fast" | "deep"')
    expect(file).toContain('Array<string>')
    expect(file).toContain('string | null')
    expect(file).toContain('Array<number>')
    // Nested object gets its own interface named from the property path;
    // its required member renders without the optional marker.
    expect(file).toContain('interface SearchInputFilter')
    expect(file).toContain('ids: Array<number>')
  })

  test('unchanged input skips the rewrite and keeps the generation', async () => {
    const dir = await freshDir()
    const input = {
      mcpTools: [fakeMcpTool('mcp__srv__a', 'srv')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map([['srv', '']]),
      catalogDir: dir,
      statePath: statePathFor(dir),
    }
    const first = await writeToolCatalog(input)
    const second = await writeToolCatalog(input)
    expect(second.wrote).toBe(false)
    expect(second.manifest.generation).toBe(first.manifest.generation)
  })

  test('changed tool set bumps the generation', async () => {
    const dir = await freshDir()
    const opts = {
      lazyBuiltInTools: [],
      serverDescriptions: new Map<string, string>(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    }
    const first = await writeToolCatalog({
      ...opts,
      mcpTools: [fakeMcpTool('mcp__srv__a', 'srv')],
    })
    const second = await writeToolCatalog({
      ...opts,
      mcpTools: [
        fakeMcpTool('mcp__srv__a', 'srv'),
        fakeMcpTool('mcp__srv__b', 'srv'),
      ],
    })
    expect(second.wrote).toBe(true)
    expect(second.manifest.generation).toBe(first.manifest.generation + 1)
    expect(second.manifest.servers[0]!.toolCount).toBe(2)
  })

  test('legacy JSON catalog files are removed; stray .ts files are kept', async () => {
    const dir = await freshDir()
    await mkdir(join(dir, 'servers'), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), '{}')
    await writeFile(join(dir, 'builtins.json'), '{}')
    await writeFile(join(dir, 'servers', 'gone.json'), '{}')
    // No manifest entry claims gone.ts, but union semantics never delete a
    // .ts file on age alone — only the age GC does, and this one is fresh.
    await writeFile(join(dir, 'servers', 'gone.ts'), '// stray\n')
    await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__srv__a', 'srv')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    const { readdir } = await import('fs/promises')
    expect(await readdir(dir)).toEqual(['servers'])
    // readdir order is filesystem-dependent, not insertion order.
    expect((await readdir(join(dir, 'servers'))).sort()).toEqual([
      'gone.ts',
      'srv.ts',
    ])
  })

  test('union: a server missing from the render keeps its file and entry', async () => {
    const dir = await freshDir()
    const first = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__a__x', 'a'), fakeMcpTool('mcp__b__y', 'b')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    expect(first.wrote).toBe(true)
    // Session two sees only server "a" (e.g. server b is still connecting).
    const second = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__a__x', 'a')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    expect(second.manifest.servers.map(s => s.name)).toEqual(['a', 'b'])
    // b's bytes are untouched, so the entry carries the first generation's
    // content hash and the file is still on disk.
    const b = second.manifest.servers.find(s => s.name === 'b')!
    const onDisk = await readFile(join(dir, b.file), 'utf8')
    expect(createHash('sha256').update(onDisk).digest('hex').slice(0, 16)).toBe(
      b.hash,
    )
  })

  test('age GC reaps an unrendered server only when unclaimed and old', async () => {
    const dir = await freshDir()
    const { utimes } = await import('fs/promises')
    await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__old__x', 'old')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await utimes(join(dir, 'servers', 'old.ts'), aged, aged)

    // Claimed by a live session: kept.
    const kept = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__new__x', 'new')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
      knownServers: new Set(['old', 'new']),
    })
    expect(kept.manifest.servers.map(s => s.name)).toEqual(['new', 'old'])
    expect(existsSync(join(dir, 'servers', 'old.ts'))).toBe(true)

    // Unclaimed and aged: reaped.
    const reaped = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__new__x', 'new')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    expect(reaped.manifest.servers.map(s => s.name)).toEqual(['new'])
    expect(existsSync(join(dir, 'servers', 'old.ts'))).toBe(false)
  })

  test('a carried-forward entry claimed by the other catalog dir is dropped', async () => {
    const dir = await freshDir()
    await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__old__x', 'old')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
    })

    // The server re-homed to the other catalog dir (e.g. project scope took
    // over): dropped immediately, without waiting out the age GC.
    const dropped = await writeToolCatalog({
      mcpTools: [fakeMcpTool('mcp__new__x', 'new')],
      lazyBuiltInTools: [],
      serverDescriptions: new Map(),
      catalogDir: dir,
      statePath: statePathFor(dir),
      knownServers: new Set(['old', 'new']),
      claimedElsewhere: new Set(['old']),
    })
    expect(dropped.manifest.servers.map(s => s.name)).toEqual(['new'])
    expect(existsSync(join(dir, 'servers', 'old.ts'))).toBe(false)
  })
})

describe('mcp_tools_delta reminder', () => {
  test('first announce with no history is the full catalog', async () => {
    const dir = await freshDir()
    const ctx = makeContext([fakeMcpTool('mcp__srv__a', 'srv')])
    const atts = await getMcpToolsDeltaAttachment(ctx, [], {
      catalogDir: dir,
      statePath: statePathFor(dir),
    })
    expect(atts.length).toBe(1)
    const att = atts[0] as Extract<Attachment, { type: 'mcp_tools_delta' }>
    expect(att.addedNames).toEqual(['srv'])
    expect(att.changedNames).toEqual([])
    expect(att.removedNames).toEqual([])
    expect(att.servers.length).toBe(1)
    expect(att.servers[0]!.toolCount).toBe(1)
    expect(att.servers[0]!.file).toBe('servers/srv.ts')
  })

  test('diff against the announced snapshot reports add/remove/change', async () => {
    const dir = await freshDir()
    const opts = { catalogDir: dir, statePath: statePathFor(dir) }
    const announced = await getMcpToolsDeltaAttachment(
      makeContext([fakeMcpTool('mcp__srv__a', 'srv')]),
      [],
      opts,
    )
    const messages = [attachMessage(announced[0] as Attachment)]

    const noChange = await getMcpToolsDeltaAttachment(
      makeContext([fakeMcpTool('mcp__srv__a', 'srv')]),
      messages,
      opts,
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
      opts,
    )
    expect(changed.length).toBe(1)
    const att = changed[0] as Extract<Attachment, { type: 'mcp_tools_delta' }>
    expect(att.addedNames).toEqual(['new'])
    expect(att.removedNames).toEqual([])

    // Server gone from the pool → removed.
    const removed = await getMcpToolsDeltaAttachment(
      makeContext([fakeMcpTool('mcp__new__b', 'new')]),
      messages,
      opts,
    )
    expect(removed.length).toBe(1)
    const rem = removed[0] as Extract<Attachment, { type: 'mcp_tools_delta' }>
    expect(rem.removedNames).toEqual(['srv'])
    expect(rem.addedNames).toEqual(['new'])
  })
})
