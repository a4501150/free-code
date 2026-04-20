/**
 * Dumps the wire-shape (name + description + input_schema) of every built-in
 * tool to disk, so prompt/schema bloat can be audited and trimmed.
 *
 * This is built, not run directly — `bun:bundle` + feature flags only resolve
 * through `bun build`. See scripts/build-and-run-dump.ts for the runner.
 *
 * Outputs two files (paths passed as argv[2] / argv[3]):
 *   - JSON:     [{ name, description, input_schema }, ...]
 *   - Markdown: one section per tool
 */
import { writeFileSync } from 'fs'
import { enableConfigs } from '../src/utils/config.js'
import { getAllBaseTools } from '../src/tools.js'
import { toolToAPISchema } from '../src/utils/api.js'
import type { ToolPermissionContext } from '../src/types/permissions.js'

enableConfigs()

const [, , jsonPath, mdPath] = process.argv
if (!jsonPath || !mdPath) {
  console.error('Usage: dump-tool-schemas <json-out> <md-out>')
  process.exit(2)
}

const permissionContext: ToolPermissionContext = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
}

const tools = getAllBaseTools().filter(t => t.isEnabled())

const schemas = await Promise.all(
  tools.map(async tool => {
    const schema = await toolToAPISchema(tool, {
      getToolPermissionContext: async () => permissionContext,
      tools,
      agents: [],
    })
    return {
      name: (schema as { name?: string }).name ?? '',
      description: (schema as { description?: string }).description ?? '',
      input_schema: (schema as { input_schema: unknown }).input_schema,
    }
  }),
)

// Stable sort by name so the output diffs cleanly session-over-session
schemas.sort((a, b) => a.name.localeCompare(b.name))

writeFileSync(jsonPath, JSON.stringify(schemas, null, 2))

const descChars = (s: string) => s.length
const schemaChars = (s: unknown) => JSON.stringify(s).length

const md: string[] = []
md.push('# Built-in tool schemas')
md.push('')
md.push(`Total tools: **${schemas.length}**`)
md.push('')
md.push('| Tool | Description chars | Schema chars |')
md.push('| --- | ---: | ---: |')
for (const s of schemas) {
  md.push(
    `| \`${s.name}\` | ${descChars(s.description)} | ${schemaChars(s.input_schema)} |`,
  )
}
md.push('')

for (const s of schemas) {
  md.push(`## ${s.name}`)
  md.push('')
  md.push(`- description: ${descChars(s.description)} chars`)
  md.push(`- input_schema: ${schemaChars(s.input_schema)} chars`)
  md.push('')
  md.push('### Description')
  md.push('')
  md.push('```')
  md.push(s.description)
  md.push('```')
  md.push('')
  md.push('### Input schema')
  md.push('')
  md.push('```json')
  md.push(JSON.stringify(s.input_schema, null, 2))
  md.push('```')
  md.push('')
}

writeFileSync(mdPath, md.join('\n'))

console.log(
  `Dumped ${schemas.length} tools → ${jsonPath} (${descChars(JSON.stringify(schemas))} chars) and ${mdPath}`,
)
