/**
 * One-shot inspect script: dumps the wire-shape of a tool schema + the betas
 * computed for a given model, so we can see what reaches the Anthropic API.
 *
 * Run via build-and-run-inspect.ts (matches dump-tool-schemas pattern).
 */
import { enableConfigs } from '../src/utils/config.js'
import { getAllBaseTools } from '../src/tools.js'
import { toolToAPISchema } from '../src/utils/api.js'
import { getAllModelBetas } from '../src/utils/betas.js'
import type { ToolPermissionContext } from '../src/types/permissions.js'

enableConfigs()

const permissionContext: ToolPermissionContext = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
}

const model = process.argv[2] ?? 'claude-opus-4-7'
const toolName = process.argv[3] ?? 'Read'

const tools = getAllBaseTools().filter(t => t.isEnabled())

console.log('Betas for', model, '=>')
console.log(JSON.stringify(getAllModelBetas(model), null, 2))

const tool = tools.find(t => t.name === toolName)
if (!tool) {
  console.error(
    'Tool',
    toolName,
    'not found among',
    tools.map(t => t.name).join(', '),
  )
  process.exit(1)
}

const schema = await toolToAPISchema(tool, {
  getToolPermissionContext: async () => permissionContext,
  tools,
  agents: [],
  model,
})

console.log('\n--- Tool schema for', toolName, '+ model', model, '---')
console.log(JSON.stringify(schema, null, 2))
