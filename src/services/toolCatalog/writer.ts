// Filesystem catalog of tools the model cannot see in the API tools[] array.
// The harness renders MCP tool schemas (and lazily-exposed built-ins) into
// JSON files under <config-home>/tool-catalog/; the model reads them with
// Read/Bash and calls the tools through InvokeTool. Files are the source of
// truth: on session start and on every MCP connect/disconnect/schema change
// the writer re-renders them, bumping `generation` only when bytes change.

import { createHash } from 'crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'fs/promises'
import { join } from 'path'
import type { Tool } from '../../Tool.js'
import { normalizeNameForMCP } from '../mcp/normalization.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const CATALOG_DIR = 'tool-catalog'
const SERVERS_DIR = 'servers'
const MANIFEST_FILE = 'manifest.json'

export type CatalogServerSnapshot = {
  name: string
  file: string
  toolCount: number
  hash: string
}

export type CatalogManifest = {
  generation: number
  updated: string
  servers: Array<CatalogServerSnapshot & { description: string }>
  builtins: string[]
}

export function toolCatalogDir(): string {
  return join(getClaudeConfigHomeDir(), CATALOG_DIR)
}

export async function readToolCatalogManifest(
  dir?: string,
): Promise<CatalogManifest | null> {
  try {
    const raw = await readFile(
      join(dir ?? toolCatalogDir(), MANIFEST_FILE),
      'utf8',
    )
    const parsed = JSON.parse(raw) as CatalogManifest
    if (
      typeof parsed?.generation !== 'number' ||
      !Array.isArray(parsed.servers)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

// JSON.stringify with sorted object keys so rendered bytes change only when
// content changes (insertion order must not leak into the catalog).
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2) + '\n'
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortValue(v)
    }
    return out
  }
  return value
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, path)
}

const promptOpts = {
  getToolPermissionContext: async () => ({}) as never,
  tools: [] as Tool[],
  agents: [] as never[],
  allowedAgentTypes: undefined,
}

async function toolDescription(tool: Tool): Promise<string> {
  try {
    return await tool.prompt(promptOpts)
  } catch {
    return ''
  }
}

type RenderedFile = { path: string; content: string }

function serverFileName(serverName: string): string {
  return `${normalizeNameForMCP(serverName)}.json`
}

async function renderCatalog(
  mcpTools: Tool[],
  lazyBuiltInTools: Tool[],
  serverDescriptions: Map<string, string>,
  dir: string,
): Promise<{
  files: RenderedFile[]
  servers: CatalogManifest['servers']
  builtins: string[]
}> {
  const byServer = new Map<string, Tool[]>()
  for (const tool of mcpTools) {
    const server = tool.mcpInfo?.serverName
    if (!server) continue
    const list = byServer.get(server) ?? []
    list.push(tool)
    byServer.set(server, list)
  }

  const servers: CatalogManifest['servers'] = []
  const files: RenderedFile[] = []
  for (const [serverName, tools] of [...byServer.entries()].sort()) {
    const entries = []
    for (const tool of [...tools].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      entries.push({
        name: tool.name,
        description: await toolDescription(tool),
        inputSchema: tool.inputJSONSchema ?? null,
        annotations: {
          readOnly: tool.isReadOnly({}) || false,
          destructive: tool.isDestructive?.({}) || false,
          openWorld: tool.isOpenWorld?.({}) || false,
        },
      })
    }
    const content = stableStringify({ server: serverName, tools: entries })
    const file = join(SERVERS_DIR, serverFileName(serverName))
    files.push({ path: join(dir, file), content })
    servers.push({
      name: serverName,
      description: serverDescriptions.get(serverName) ?? '',
      file,
      toolCount: entries.length,
      hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
    })
  }
  servers.sort((a, b) => a.name.localeCompare(b.name))

  const builtins: string[] = []
  if (lazyBuiltInTools.length > 0) {
    const entries = []
    for (const tool of [...lazyBuiltInTools].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      builtins.push(tool.name)
      entries.push({
        name: tool.name,
        description: await toolDescription(tool),
        inputSchema: tool.inputJSONSchema ?? null,
      })
    }
    files.push({
      path: join(dir, 'builtins.json'),
      content: stableStringify({ builtins: entries }),
    })
  }

  return { files, servers, builtins }
}

// Skipping a rewrite requires the previous manifest to describe exactly the
// current render. Each server entry carries a content hash, so equality
// proves the files on disk are byte-identical to what we would write; the
// manifest's `updated` timestamp is excluded so time alone is not content.
function sameSnapshot(
  previous: CatalogManifest,
  servers: CatalogManifest['servers'],
  builtins: string[],
): boolean {
  if (previous.builtins.length !== builtins.length) return false
  if (!previous.builtins.every((b, i) => b === builtins[i])) return false
  if (previous.servers.length !== servers.length) return false
  return previous.servers.every(
    (s, i) =>
      s.name === servers[i].name &&
      s.description === servers[i].description &&
      s.file === servers[i].file &&
      s.toolCount === servers[i].toolCount &&
      s.hash === servers[i].hash,
  )
}

export type CatalogWriteResult = {
  manifest: CatalogManifest
  wrote: boolean
}

export async function writeToolCatalog(opts: {
  mcpTools: Tool[]
  lazyBuiltInTools: Tool[]
  serverDescriptions: Map<string, string>
  /** Test override; defaults to <config-home>/tool-catalog. */
  catalogDir?: string
}): Promise<CatalogWriteResult> {
  const dir = opts.catalogDir ?? toolCatalogDir()
  const { files, servers, builtins } = await renderCatalog(
    opts.mcpTools,
    opts.lazyBuiltInTools,
    opts.serverDescriptions,
    dir,
  )

  const previous = await readToolCatalogManifest(dir)
  if (previous && sameSnapshot(previous, servers, builtins)) {
    return { manifest: previous, wrote: false }
  }

  await mkdir(join(dir, SERVERS_DIR), { recursive: true })
  for (const f of files) {
    await writeFileAtomic(f.path, f.content)
  }

  // Remove server files whose server vanished from the pool.
  try {
    const expected = new Set(servers.map(s => serverFileName(s.name)))
    for (const name of await readdir(join(dir, SERVERS_DIR))) {
      if (name.endsWith('.json') && !expected.has(name)) {
        await unlink(join(dir, SERVERS_DIR, name)).catch(() => {})
      }
    }
  } catch {
    // dir may not exist yet on first render
  }

  const manifest: CatalogManifest = {
    generation: (previous?.generation ?? 0) + 1,
    updated: new Date().toISOString(),
    servers,
    builtins,
  }
  await writeFileAtomic(join(dir, MANIFEST_FILE), stableStringify(manifest))
  return { manifest, wrote: true }
}
