// Code catalog: the model-facing view of tools that are not in the API
// tools[] array. The harness renders each MCP server (and lazily-exposed
// built-ins) as a generated TypeScript module — typed forwarding functions
// with JSDoc — under <config-home>/tool-catalog/. The model greps those files,
// reads the declarations it needs, and calls the functions from a RunCode
// script. Nothing in the directory is executed: the files are documentation,
// and the loader builds the runtime namespace from the live tool pool with the
// same identifier rules as here.
//
// Harness state (generation, per-server content hashes) lives in
// <config-home>/tool-catalog.json — OUTSIDE the model-facing directory, never
// named in the prompt. Rendering is byte-stable (sorted declarations, no
// insertion-order leaks), so files are rewritten and the generation bumped
// only when content changes.

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
import { getMcpPrefix } from '../mcp/mcpStringUtils.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'

const CATALOG_DIR = 'tool-catalog'
const SERVERS_DIR = 'servers'
const STATE_FILE = 'tool-catalog.json'

export type CatalogServerSnapshot = {
  name: string
  file: string
  toolCount: number
  hash: string
  /**
   * Cheap input digest (tool names, schemas, descriptions) used to skip
   * re-rendering a server whose inputs are unchanged. The manifest hash is
   * verified against the file on disk, so a deleted or edited file still
   * forces a re-render. Absent in states written before digests existed.
   */
  digest?: string
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

export function toolCatalogStatePath(): string {
  return join(getClaudeConfigHomeDir(), STATE_FILE)
}

export async function readToolCatalogState(
  statePath?: string,
): Promise<CatalogManifest | null> {
  try {
    const raw = await readFile(statePath ?? toolCatalogStatePath(), 'utf8')
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

// ---------------------------------------------------------------------------
// Identifier rules — the loader's runtime namespaces use these same rules, so
// a name read in a declaration is a name that can be imported.

const TS_RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'await',
  'arguments',
  'eval',
  'undefined',
  'break_',
])

/**
 * Export identifier for a tool within its own server/builtin scope. MCP tool
 * names carry the mcp__<server>__ prefix, which is dropped here (the file is
 * already server-scoped). Anywhere identifier-unsafe, `_` is substituted —
 * deterministically, so docs and runtime bindings agree on the name.
 */
export function catalogExportName(
  toolName: string,
  mcpServerName?: string,
): string {
  const prefix = mcpServerName !== undefined ? getMcpPrefix(mcpServerName) : ''
  const base =
    prefix !== '' && toolName.startsWith(prefix)
      ? toolName.slice(prefix.length)
      : toolName
  let id = base.replace(/[^A-Za-z0-9_$]/g, '_')
  if (!/^[A-Za-z_$]/.test(id)) id = `t_${id}`
  if (TS_RESERVED.has(id)) id = `${id}_`
  return id
}

function pascalCase(s: string): string {
  return (
    s
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map(w => w[0]!.toUpperCase() + w.slice(1))
      .join('') || 'T'
  )
}

/** Block comment; a comment-terminator sequence inside content is broken apart. */
function blockComment(text: string, lines: string[] = []): string {
  const safe = text.replace(/\*\//g, '*\\/').replace(/\r/g, '')
  const body = safe
    .split('\n')
    .map(l => (l.length > 0 ? ` * ${l}` : ' *'))
    .join('\n')
  const extra = lines.map(l => ` *\n * ${l}`).join('')
  return `/**\n${body}${extra}\n */`
}

// ---------------------------------------------------------------------------
// JSON Schema -> TypeScript type emission. Property order is sorted so
// emission-order noise never reaches the file bytes; enum order is semantic
// and preserved.

type JsonSchema = Record<string, unknown>

type TypeEmit = { text: string; decls: Map<string, string> }

function literalText(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
    return String(v)
  }
  return 'unknown'
}

function describeLines(sch: JsonSchema): string[] {
  const lines: string[] = []
  if (typeof sch.description === 'string' && sch.description.length > 0) {
    lines.push(...sch.description.replace(/\r/g, '').split('\n'))
  }
  if ('default' in sch && sch.default !== undefined) {
    try {
      lines.push(`@default ${JSON.stringify(sch.default)}`)
    } catch {
      // non-serializable default: no line
    }
  }
  return lines
}

function typeFromSchema(schema: unknown, name: string): TypeEmit {
  if (schema === true || schema === undefined || schema === null) {
    return { text: 'unknown', decls: new Map() }
  }
  if (schema === false) {
    return { text: 'never', decls: new Map() }
  }
  if (typeof schema !== 'object') {
    return { text: 'unknown', decls: new Map() }
  }
  const sch = schema as JsonSchema

  const emitParts = (
    subs: unknown[],
    nameSuffix: string,
    joiner: ' | ' | ' & ',
  ): TypeEmit => {
    const parts: string[] = []
    const decls = new Map<string, string>()
    subs.forEach((sub, i) => {
      const e = typeFromSchema(sub, `${name}${nameSuffix}${i}`)
      parts.push(e.text)
      for (const [k, v] of e.decls) decls.set(k, v)
    })
    return { text: parts.join(joiner), decls }
  }

  if (Array.isArray(sch.type) && sch.type.length > 1) {
    return emitParts(
      sch.type.map(t => ({ ...sch, type: t })),
      'Type',
      ' | ',
    )
  }
  const singleType = Array.isArray(sch.type) ? sch.type[0] : sch.type

  if (Array.isArray(sch.anyOf)) return emitParts(sch.anyOf, 'Any', ' | ')
  if (Array.isArray(sch.oneOf)) return emitParts(sch.oneOf, 'One', ' | ')
  if (Array.isArray(sch.allOf)) return emitParts(sch.allOf, 'All', ' & ')

  if (Array.isArray(sch.enum) && sch.enum.length > 0) {
    return {
      text: [...new Set(sch.enum.map(literalText))].join(' | '),
      decls: new Map(),
    }
  }
  if ('const' in sch) {
    return { text: literalText(sch.const), decls: new Map() }
  }

  const type = typeof singleType === 'string' ? singleType : undefined

  if (type === 'object' || sch.properties || sch.additionalProperties) {
    const props =
      typeof sch.properties === 'object' && sch.properties !== null
        ? (sch.properties as Record<string, unknown>)
        : {}
    const required = Array.isArray(sch.required) ? new Set(sch.required) : null
    const members: string[] = []
    const decls = new Map<string, string>()
    for (const key of Object.keys(props).sort()) {
      const propSchema = props[key]
      const child = typeFromSchema(propSchema, `${name}${pascalCase(key)}`)
      for (const [k, v] of child.decls) decls.set(k, v)
      const lines =
        typeof propSchema === 'object' && propSchema !== null
          ? describeLines(propSchema as JsonSchema)
          : []
      if (lines.length > 0) {
        members.push(
          blockComment(lines[0]!, lines.slice(1))
            .split('\n')
            .map(l => `  ${l}`)
            .join('\n'),
        )
      }
      const opt = required && !required.has(key) ? '?' : ''
      const propKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? key
        : JSON.stringify(key)
      members.push(`  ${propKey}${opt}: ${child.text}`)
    }
    if (sch.additionalProperties === true) {
      members.push('  [k: string]: unknown')
    } else if (
      typeof sch.additionalProperties === 'object' &&
      sch.additionalProperties !== null
    ) {
      const child = typeFromSchema(sch.additionalProperties, `${name}Value`)
      for (const [k, v] of child.decls) decls.set(k, v)
      if (Object.keys(props).length === 0) {
        return { text: `Record<string, ${child.text}>`, decls }
      }
      members.push(`  [k: string]: ${child.text}`)
    }
    if (members.length === 0) {
      return { text: 'Record<string, unknown>', decls }
    }
    decls.set(name, `interface ${name} {\n${members.join('\n')}\n}`)
    return { text: name, decls }
  }

  if (type === 'array') {
    const item = typeFromSchema(sch.items, `${name}Item`)
    return { text: `Array<${item.text}>`, decls: item.decls }
  }

  switch (type) {
    case 'string':
      return { text: 'string', decls: new Map() }
    case 'number':
    case 'integer':
      return { text: 'number', decls: new Map() }
    case 'boolean':
      return { text: 'boolean', decls: new Map() }
    case 'null':
      return { text: 'null', decls: new Map() }
    default:
      return { text: 'unknown', decls: new Map() }
  }
}

function inputSchemaOf(tool: Tool): unknown {
  try {
    return tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema as never)
  } catch {
    return null
  }
}

const PRELUDE = [
  'type ToolResult = string',
  'declare const freecode: {',
  '  invoke(name: string, args: Record<string, unknown>): Promise<ToolResult>',
  '}',
].join('\n')

async function toolDescription(tool: Tool): Promise<string> {
  try {
    return await tool.prompt(promptOpts)
  } catch {
    return ''
  }
}

const promptOpts = {
  getToolPermissionContext: async () => ({}) as never,
  tools: [] as Tool[],
  agents: [] as never[],
  allowedAgentTypes: undefined,
}

function annotationLines(tool: Tool): string[] {
  const flags: string[] = []
  try {
    if (tool.isReadOnly({})) flags.push('@readOnly')
    if (tool.isDestructive?.({})) flags.push('@destructive')
    if (tool.isOpenWorld?.({})) flags.push('@openWorld')
  } catch {
    // An annotation that can't be computed emits no flags rather than
    // failing the whole render; the function itself is still declared.
  }
  return flags
}

async function renderModule(
  header: string | null,
  tools: Tool[],
  exportNameOf: (tool: Tool) => string,
): Promise<string> {
  const out: string[] = [
    '// Generated by free-code. Do not edit — rewritten whenever the catalog changes.',
  ]
  if (header && header.trim().length > 0) {
    out.push(blockComment(header.trim()))
  }
  out.push(PRELUDE)

  const decls = new Map<string, string>()
  const fns: string[] = []
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const exported = exportNameOf(tool)
    const rootName = `${pascalCase(exported)}Input`
    const schema = inputSchemaOf(tool)
    const argsType = schema
      ? (() => {
          const e = typeFromSchema(schema, rootName)
          for (const [k, v] of e.decls) decls.set(k, v)
          return e.text
        })()
      : 'Record<string, unknown>'
    const doc = blockComment(await toolDescription(tool), annotationLines(tool))
    fns.push(
      `${doc}\nexport function ${exported}(args: ${argsType}): Promise<ToolResult> {\n  return freecode.invoke(${JSON.stringify(
        tool.name,
      )}, args)\n}`,
    )
  }

  const sortedDecls = [...decls.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, text]) => text)
  if (sortedDecls.length > 0) out.push(sortedDecls.join('\n\n'))
  out.push(fns.join('\n\n'))
  return out.join('\n\n') + '\n'
}

type RenderedFile = { path: string; content: string }

function serverFileName(serverName: string): string {
  return `${normalizeNameForMCP(serverName)}.ts`
}

// Cheap per-server input digest: names, raw schemas, descriptions, flags.
// Substitutes for re-rendering when the inputs are unchanged — MCP tools
// carry their raw JSON schema (inputJSONSchema), so this skips the TS
// codegen, the string assembly, and the content hash of the full module.
async function computeServerDigest(
  description: string,
  tools: Tool[],
): Promise<string> {
  const h = createHash('sha256')
  h.update(description)
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(tool.name)
    h.update('\0')
    h.update(JSON.stringify(inputSchemaOf(tool) ?? null))
    h.update('\0')
    h.update(await toolDescription(tool))
    h.update('\0')
    h.update(annotationLines(tool).join(','))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

async function renderCatalog(
  mcpTools: Tool[],
  lazyBuiltInTools: Tool[],
  serverDescriptions: Map<string, string>,
  dir: string,
  previous: CatalogManifest | null,
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
  const previousByServer = new Map(
    (previous?.servers ?? []).map(s => [s.name, s]),
  )
  for (const [serverName, tools] of [...byServer.entries()].sort()) {
    const description = serverDescriptions.get(serverName) ?? ''
    const digest = await computeServerDigest(description, tools)
    const file = join(SERVERS_DIR, serverFileName(serverName))
    const prev = previousByServer.get(serverName)
    if (prev?.digest === digest && prev.description === description) {
      // Digest says inputs are unchanged; the stored content hash checked
      // against the file on disk says the bytes are still there untouched.
      try {
        const onDisk = await readFile(join(dir, file), 'utf8')
        if (
          createHash('sha256').update(onDisk).digest('hex').slice(0, 16) ===
          prev.hash
        ) {
          servers.push({
            name: serverName,
            description,
            file,
            toolCount: tools.length,
            hash: prev.hash,
            digest,
          })
          continue
        }
      } catch {
        // Missing/unreadable file: fall through and re-render.
      }
    }
    const content = await renderModule(description || null, tools, tool =>
      catalogExportName(tool.name, serverName),
    )
    files.push({ path: join(dir, file), content })
    servers.push({
      name: serverName,
      description,
      file,
      toolCount: tools.length,
      hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
      digest,
    })
  }
  servers.sort((a, b) => a.name.localeCompare(b.name))

  const builtins: string[] = []
  if (lazyBuiltInTools.length > 0) {
    for (const tool of lazyBuiltInTools) builtins.push(tool.name)
    builtins.sort()
    files.push({
      path: join(dir, 'builtins.ts'),
      content: await renderModule(
        'Lazily-exposed built-in tools. Same call shape as the server modules.',
        lazyBuiltInTools,
        tool => catalogExportName(tool.name),
      ),
    })
  }

  return { files, servers, builtins }
}

// Skipping a rewrite requires the previous state to describe exactly the
// current render. Each server entry carries a content hash, so equality
// proves the files on disk are byte-identical to what we would write; the
// state's `updated` timestamp is excluded so time alone is not content.
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
      s.hash === servers[i].hash &&
      (s.digest ?? '') === (servers[i].digest ?? ''),
  )
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, path)
}

// Files from the pre-code-catalog layout (manifest + JSON schemas) are removed
// once so the directory holds only TypeScript.
const LEGACY_ROOT_FILES = ['manifest.json', 'builtins.json']

async function removeUnexpected(
  dirPath: string,
  expected: Set<string>,
): Promise<void> {
  try {
    for (const name of await readdir(dirPath)) {
      if (name.startsWith('.')) continue
      const matches = name.endsWith('.ts') || name.endsWith('.json')
      if (matches && !expected.has(name)) {
        await unlink(join(dirPath, name)).catch(() => {})
      }
    }
  } catch {
    // dir may not exist yet on first render
  }
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
  /** Test override; defaults to <config-home>/tool-catalog.json. */
  statePath?: string
}): Promise<CatalogWriteResult> {
  const dir = opts.catalogDir ?? toolCatalogDir()
  const statePath = opts.statePath ?? toolCatalogStatePath()
  const previous = await readToolCatalogState(statePath)
  const { files, servers, builtins } = await renderCatalog(
    opts.mcpTools,
    opts.lazyBuiltInTools,
    opts.serverDescriptions,
    dir,
    previous,
  )

  if (previous && sameSnapshot(previous, servers, builtins)) {
    return { manifest: previous, wrote: false }
  }

  await mkdir(join(dir, SERVERS_DIR), { recursive: true })
  for (const f of files) {
    await writeFileAtomic(f.path, f.content)
  }

  for (const legacy of LEGACY_ROOT_FILES) {
    await unlink(join(dir, legacy)).catch(() => {})
  }
  // Remove server files whose server vanished from the pool, plus legacy
  // per-server JSON from before the code catalog.
  const expectedServers = new Set(servers.map(s => serverFileName(s.name)))
  await removeUnexpected(join(dir, SERVERS_DIR), expectedServers)
  const expectedRoot = new Set(['builtins.ts'])
  if (builtins.length === 0) expectedRoot.delete('builtins.ts')
  await removeUnexpected(dir, expectedRoot)

  const manifest: CatalogManifest = {
    generation: (previous?.generation ?? 0) + 1,
    updated: new Date().toISOString(),
    servers,
    builtins,
  }
  await writeFileAtomic(statePath, JSON.stringify(manifest, null, 2) + '\n')
  return { manifest, wrote: true }
}
